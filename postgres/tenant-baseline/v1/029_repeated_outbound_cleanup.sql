-- Step 029: remove the second copy of a repeated outbound chat-store message.
--
-- LinkedIn records a connection-request note twice: when the invite is sent,
-- and again under a new message id when the conversation is created on
-- acceptance. Linked Helper's chat store keeps both, the sync delivered both
-- (they have different external ids, so nothing collapsed them), and every
-- accepted invite with a note showed the note twice in the thread. On
-- production, 2026-10-21: 429 threads held a repeated outbound text, 424 of
-- them the invite note, the first copy at the real send time.
--
-- Agent 1.30.0 stops sending the later copy (`drop_repeated_outbound`). This
-- step deletes the copies already stored, keeping the earliest of each
-- (instance, profile, content) among outbound chat-store rows. Apply it AFTER
-- every notebook runs 1.30.0, or an older agent re-delivers the copy on its
-- next sync.
--
-- What goes with a deleted row: its step attribution (ON DELETE CASCADE).
-- A follow-up's supporting_message_id is SET NULL by its own foreign key; a
-- training case cut at a deleted row falls back to the whole thread (SET
-- NULL). Inbound, legacy (no external id) and imported rows are untouched;
-- no milestone moves, because the earliest copy stays.

SET ROLE app_owner;

DO $$
DECLARE
  deleted integer;
BEGIN
  WITH ranked AS (
    SELECT m.id,
           row_number() OVER (PARTITION BY m.instance_id, m.profile_url, m.content_hash
                              ORDER BY m.sent_at, m.id) AS copy
      FROM public.messages m
     WHERE m.direction = 'out'
       AND m.external_id IS NOT NULL
       AND m.content_hash <> ''
       AND coalesce(btrim(m.body), '') <> ''
  )
  DELETE FROM public.messages m
   USING ranked r
   WHERE m.id = r.id AND r.copy > 1;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RAISE NOTICE 'step 029: removed % repeated outbound copies', deleted;
END
$$;

RESET ROLE;
