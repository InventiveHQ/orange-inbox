-- One-line AI thread summaries (Superhuman-style "Auto Summarize"), generated
-- lazily by Workers AI when a thread is opened and cached here on the control
-- DB so re-opening is instant and free.
--
--   summary             — the cached one-liner (NULL until first generated).
--   summary_message_id  — the threads_index.last_message_id the summary was
--                         built for. When a new message arrives last_message_id
--                         changes, so summary_message_id != last_message_id
--                         means "stale, regenerate on next open".

ALTER TABLE threads_index ADD COLUMN summary TEXT;
ALTER TABLE threads_index ADD COLUMN summary_message_id TEXT;
