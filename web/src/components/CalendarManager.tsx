// Placeholder Calendar page. Calendar events parsed from inbound iCal
// attachments already live in message_calendar_events (see ThreadView's
// CalendarEventCard); a future version of this page will surface them as a
// real timeline + RSVP view. For now this is a scaffold so the bottom-row
// nav has something to land on.
export default function CalendarManager() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800">
        <h1 className="text-base font-semibold">Calendar</h1>
      </header>
      <div className="flex-1 flex items-center justify-center text-center px-6">
        <div className="max-w-md">
          <h2 className="text-lg font-semibold mb-2">Calendar is coming</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Meeting invites that land in your inbox already render inline as
            event cards with RSVP buttons. A unified upcoming-events view will
            live here.
          </p>
        </div>
      </div>
    </div>
  );
}
