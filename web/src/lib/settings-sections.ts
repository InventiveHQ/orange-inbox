// Section list for /inbox/settings. Owned here (rather than inside
// SettingsManager) so the layout can render the same list in the
// context-aware drawer without duplicating the visibility flags.
//
// Each entry's `id` is the anchor of the corresponding section in
// SettingsManager.tsx — clicking a drawer entry scrolls that anchor
// into view.

export interface SettingsSection {
  id: string;
  label: string;
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
    { id: "blocked-senders", label: "Blocked senders" },
    { id: "sending", label: "Sending" },
    { id: "notifications", label: "Notifications" },
    ...(hasAuditAccess ? [{ id: "audit-log", label: "Audit log" }] : []),
    { id: "calendar-subscription", label: "Calendar subscription" },
    { id: "export", label: "Import / Export" },
    ...(isAdmin ? [{ id: "storage", label: "Storage" }] : []),
    { id: "appearance", label: "Appearance" },
    { id: "about", label: "About" },
  ];
}
