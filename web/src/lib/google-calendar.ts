// Google Calendar integration for meeting booking (orange-inbox#108, #113).
//
// OAuth connect, encrypted token storage + refresh, FreeBusy queries, and
// event insert/patch/delete. Google Meet links are generated as a side effect
// of events.insert with conferenceData (calendar-coupled — #113); a plain
// insert produces no Meet link.
//
// Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (worker secrets). Until
// those are provisioned googleConfigured() is false and booking links simply
// can't attach Google calendars — Orange-native calendars still work fully.

import { getEnv } from "./db";
import { decryptSecret, encryptSecret } from "./crypto";
import {
  markConnectionError,
  updateConnectionTokens,
  type CalendarConnection,
} from "./booking";
import type { BusyWindow } from "./calendar";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const API = "https://www.googleapis.com/calendar/v3";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

interface GoogleCfg {
  clientId: string;
  clientSecret: string;
}

function cfg(): GoogleCfg | null {
  const env = getEnv() as unknown as {
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
  };
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  };
}

export function googleConfigured(): boolean {
  return cfg() !== null;
}

function requireCfg(): GoogleCfg {
  const c = cfg();
  if (!c) {
    throw new Error("Google OAuth is not configured (GOOGLE_CLIENT_ID/SECRET)");
  }
  return c;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export function buildGoogleAuthUrl(redirectUri: string, state: string): string {
  const c = requireCfg();
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export interface GoogleTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch sec
  email: string;
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
): Promise<GoogleTokenResult> {
  const c = requireCfg();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(
      `google token exchange failed: ${res.status} ${await res.text()}`,
    );
  }
  const j = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const email = await fetchGoogleEmail(j.access_token);
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? null,
    expiresAt: Math.floor(Date.now() / 1000) + (j.expires_in ?? 3600),
    email,
  };
}

async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`google userinfo failed: ${res.status}`);
  const j = (await res.json()) as { email?: string };
  if (!j.email) throw new Error("google userinfo returned no email");
  return j.email.toLowerCase();
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

// Return a valid access token for a connection, refreshing if within 60s of
// expiry. Persists the refreshed (encrypted) token.
export async function getAccessToken(conn: CalendarConnection): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (
    conn.accessTokenEnc &&
    conn.tokenExpiresAt &&
    conn.tokenExpiresAt - 60 > nowSec
  ) {
    return decryptSecret(conn.accessTokenEnc);
  }
  if (!conn.refreshTokenEnc) {
    throw new Error("connection has no refresh token; reconnect required");
  }
  const c = requireCfg();
  const refreshToken = await decryptSecret(conn.refreshTokenEnc);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const msg = `google token refresh failed: ${res.status}`;
    await markConnectionError(conn.id, msg);
    throw new Error(msg);
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = nowSec + (j.expires_in ?? 3600);
  await updateConnectionTokens(
    conn.id,
    await encryptSecret(j.access_token),
    expiresAt,
  );
  return j.access_token;
}

async function authedFetch(
  conn: CalendarConnection,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken(conn);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// FreeBusy
// ---------------------------------------------------------------------------

export async function getGoogleBusyWindows(
  conn: CalendarConnection,
  from: number,
  to: number,
): Promise<BusyWindow[]> {
  const res = await authedFetch(conn, `${API}/freeBusy`, {
    method: "POST",
    body: JSON.stringify({
      timeMin: new Date(from * 1000).toISOString(),
      timeMax: new Date(to * 1000).toISOString(),
      items: [{ id: conn.calendarId }],
    }),
  });
  if (!res.ok) {
    throw new Error(`google freeBusy failed: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as {
    calendars?: Record<string, { busy?: { start: string; end: string }[] }>;
  };
  const busy = j.calendars?.[conn.calendarId]?.busy ?? [];
  return busy.map((b) => ({
    start: Math.floor(new Date(b.start).getTime() / 1000),
    end: Math.floor(new Date(b.end).getTime() / 1000),
  }));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface GoogleEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: number; // epoch sec
  end: number;
  attendees?: string[];
  addMeet?: boolean;
}

export interface GoogleEventResult {
  eventId: string;
  htmlLink: string | null;
  meetUrl: string | null;
}

export async function insertGoogleEvent(
  conn: CalendarConnection,
  input: GoogleEventInput,
): Promise<GoogleEventResult> {
  const body: Record<string, unknown> = {
    summary: input.summary,
    start: {
      dateTime: new Date(input.start * 1000).toISOString(),
      timeZone: "UTC",
    },
    end: {
      dateTime: new Date(input.end * 1000).toISOString(),
      timeZone: "UTC",
    },
  };
  if (input.description) body.description = input.description;
  if (input.location) body.location = input.location;
  if (input.attendees?.length) {
    body.attendees = input.attendees.map((email) => ({ email }));
  }
  // Google Meet is calendar-coupled: requesting conferenceData on the insert
  // is the only way to mint a Meet link (#113).
  if (input.addMeet) {
    body.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }
  const qs = input.addMeet ? "?conferenceDataVersion=1" : "";
  const res = await authedFetch(
    conn,
    `${API}/calendars/${encodeURIComponent(conn.calendarId)}/events${qs}`,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (!res.ok) {
    throw new Error(
      `google events.insert failed: ${res.status} ${await res.text()}`,
    );
  }
  const j = (await res.json()) as {
    id: string;
    htmlLink?: string;
    hangoutLink?: string;
    conferenceData?: {
      entryPoints?: { entryPointType?: string; uri?: string }[];
    };
  };
  let meetUrl = j.hangoutLink ?? null;
  if (!meetUrl && j.conferenceData?.entryPoints) {
    const video = j.conferenceData.entryPoints.find(
      (e) => e.entryPointType === "video",
    );
    meetUrl = video?.uri ?? null;
  }
  return { eventId: j.id, htmlLink: j.htmlLink ?? null, meetUrl };
}

export async function patchGoogleEvent(
  conn: CalendarConnection,
  eventId: string,
  patch: { start?: number; end?: number },
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.start != null) {
    body.start = {
      dateTime: new Date(patch.start * 1000).toISOString(),
      timeZone: "UTC",
    };
  }
  if (patch.end != null) {
    body.end = {
      dateTime: new Date(patch.end * 1000).toISOString(),
      timeZone: "UTC",
    };
  }
  const res = await authedFetch(
    conn,
    `${API}/calendars/${encodeURIComponent(conn.calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  if (!res.ok) {
    throw new Error(
      `google events.patch failed: ${res.status} ${await res.text()}`,
    );
  }
}

export async function deleteGoogleEvent(
  conn: CalendarConnection,
  eventId: string,
): Promise<void> {
  const res = await authedFetch(
    conn,
    `${API}/calendars/${encodeURIComponent(conn.calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
  // 404/410 — event already gone; treat as success.
  if (!res.ok && res.status !== 410 && res.status !== 404) {
    throw new Error(`google events.delete failed: ${res.status}`);
  }
}
