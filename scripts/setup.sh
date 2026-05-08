#!/usr/bin/env bash
# orange-inbox: idempotent setup + deploy.
#
# Creates (or finds) the D1 database, R2 buckets, and KV namespace this app
# needs, patches the binding IDs into wrangler.jsonc, applies migrations, and
# deploys both Workers. Re-runnable: every step looks up existing resources
# before creating, and only patches REPLACE_WITH_* placeholders.
#
# Usage: ./scripts/setup.sh

set -euo pipefail

cd "$(cd "$(dirname "$0")"/.. && pwd)"
ROOT=$(pwd)

# ─── output helpers ─────────────────────────────────────────────────────────
log() { printf '\033[1;33m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }

uuid_re='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
hex32_re='[0-9a-f]{32}'

# We run wrangler from web/ so it picks up the locally-installed binary and
# the project's compatibility flags. Path is anchored to $ROOT so cd's compose.
wr() { (cd "$ROOT/web" && npx --yes wrangler "$@"); }

# ─── preflight ──────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { err "node not found in PATH"; exit 1; }
command -v npm  >/dev/null 2>&1 || { err "npm not found in PATH"; exit 1; }

log "Installing web dependencies"
(cd "$ROOT/web" && npm install --silent)
log "Installing email-worker dependencies"
(cd "$ROOT/email-worker" && npm install --silent)

if ! wr whoami >/dev/null 2>&1; then
  err "wrangler is not authenticated. Run: cd web && npx wrangler login"
  exit 1
fi
ACCOUNT=$(wr whoami 2>&1 | grep -E '^│ ' | sed -n '2p' | awk -F'│' '{print $2}' | xargs || true)
ok "Authenticated to Cloudflare${ACCOUNT:+ ($ACCOUNT)}"

# ─── D1 ────────────────────────────────────────────────────────────────────
log "D1: ensuring database 'orange-inbox'"
D1_ID=$(wr d1 list 2>&1 | grep -E '\borange-inbox\b' | grep -oE "$uuid_re" | head -1 || true)
if [ -z "$D1_ID" ]; then
  D1_ID=$(wr d1 create orange-inbox 2>&1 | grep -oE "$uuid_re" | head -1)
  ok "Created D1: $D1_ID"
else
  ok "Found existing D1: $D1_ID"
fi

# ─── R2 ────────────────────────────────────────────────────────────────────
for bucket in orange-inbox-raw orange-inbox-attachments; do
  log "R2: ensuring bucket '$bucket'"
  if wr r2 bucket info "$bucket" >/dev/null 2>&1; then
    ok "Bucket exists: $bucket"
  else
    wr r2 bucket create "$bucket" >/dev/null 2>&1 || true
    ok "Created R2 bucket: $bucket"
  fi
done

# ─── KV ────────────────────────────────────────────────────────────────────
log "KV: ensuring namespace 'DRAFTS'"
KV_LIST=$(wr kv namespace list 2>/dev/null || echo "[]")
KV_ID=$(printf '%s' "$KV_LIST" \
  | tr -d '\n' \
  | grep -oE "\\{[^}]*\"title\":[^}]*DRAFTS[^}]*\\}" \
  | grep -oE "\"id\":\\s*\"$hex32_re\"" \
  | grep -oE "$hex32_re" \
  | head -1 || true)
if [ -z "$KV_ID" ]; then
  KV_ID=$(wr kv namespace create DRAFTS 2>&1 | grep -oE "$hex32_re" | head -1)
  ok "Created KV: $KV_ID"
else
  ok "Found existing KV: $KV_ID"
fi

# ─── patch wrangler.jsonc ───────────────────────────────────────────────────
log "Patching binding IDs into wrangler.jsonc"
patch() {
  local file=$1 placeholder=$2 value=$3
  if grep -q "$placeholder" "$file"; then
    sed -i.bak "s/$placeholder/$value/g" "$file"
    rm -f "$file.bak"
    ok "  $file ← $placeholder"
  fi
}
patch "$ROOT/web/wrangler.jsonc"          "REPLACE_WITH_D1_ID" "$D1_ID"
patch "$ROOT/web/wrangler.jsonc"          "REPLACE_WITH_KV_ID" "$KV_ID"
patch "$ROOT/email-worker/wrangler.jsonc" "REPLACE_WITH_D1_ID" "$D1_ID"

# ─── migrations ────────────────────────────────────────────────────────────
log "Applying D1 migrations to remote database"
wr d1 migrations apply orange-inbox --remote
ok "Migrations applied"

# ─── deploy ─────────────────────────────────────────────────────────────────
log "Deploying email-worker"
(cd "$ROOT/email-worker" && npx --yes wrangler deploy | tail -10)
log "Deploying web (Next.js build via OpenNext — takes a couple minutes)"
(cd "$ROOT/web" && npm run deploy | tail -10)

# ─── done ───────────────────────────────────────────────────────────────────
cat <<'BANNER'

────────────────────────────────────────────
✓ Deployment complete.

Two manual steps to make it usable:

1. Cloudflare Access (login):
   Zero Trust → Access → Applications → Add a self-hosted application
   targeting your orange-inbox-web Worker URL. Add an Access policy
   (e.g. "Emails ending with @yourdomain.com"). Without Access in
   front, the app shows "Sign in required".

2. Email Routing (mail flow):
   In the Cloudflare dashboard, enable Email Routing for any domain
   you want to receive mail on, and add a rule sending mail to the
   orange-inbox-email Worker. Then sign into the app and add the
   same domain through the sidebar's "+ Add mail domain" button.

For local development:
   echo 'DEV_USER_EMAIL=you@yourdomain.com' > web/.dev.vars
   cd web && npm run dev
────────────────────────────────────────────
BANNER
