// Section list for /inbox/settings. Owned here (rather than inside
// SettingsManager) so the layout can render the same list in the
// context-aware drawer without duplicating the visibility flags.
//
// Each entry's `id` is the anchor of the corresponding section in
// SettingsManager.tsx — clicking a drawer entry scrolls that anchor
// into view. Entries with an `href` instead navigate to that route.

export interface SettingsSection {
  id: string;
  label: string;
  // When set, the entry navigates to this route instead of scrolling to an
  // in-page anchor. Used for full-page sub-areas (e.g. Scheduling) that
  // aren't sections of SettingsManager.
  href?: string;
}

export interface SettingsSectionFlags {
  isAdmin: boolean;
  hasOwnedMailboxes: boolean;
  hasAuditAccess: boolean;
}

export function buildSettingsSections({
  isAdmin,
  hasOwnedMailboxes,
  hasAuditAccess,
}: SettingsSectionFlags): SettingsSection[] {
  return [
    { id: "profile", label: "Profile" },
    { id: "mail-domains", label: "Mail domains" },
    ...(isAdmin ? [{ id: "mailbox-names", label: "Mailbox names" }] : []),
    ...(isAdmin ? [{ id: "mailbox-access", label: "Mailbox access" }] : []),
    ...(hasOwnedMailboxes ? [{ id: "signatures", label: "Signatures" }] : []),
    ...(hasOwnedMailboxes ? [{ id: "vacation", label: "Vacation responder" }] : []),
    { id: "labels", label: "Labels" },
    { id: "rules", label: "Rules" },
    { id: "inbox-layouts", label: "Inbox layouts" },
    { id: "inbox", label: "Inbox" },
    { id: "blocked-senders", label: "Blocked senders" },
    { id: "sending", label: "Sending" },
    { id: "notifications", label: "Notifications" },
    ...(hasAuditAccess ? [{ id: "audit-log", label: "Audit log" }] : []),
    { id: "calendar-subscription", label: "Calendar subscription" },
    { id: "scheduling", label: "Scheduling", href: "/scheduling" },
    { id: "export", label: "Import / Export" },
    ...(isAdmin ? [{ id: "storage", label: "Storage" }] : []),
    { id: "appearance", label: "Appearance" },
    { id: "about", label: "About" },
  ];
}
