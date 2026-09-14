-- Chat-store message identity.
--
-- The sync agent now reads Linked Helper's own chat store (chats, participants,
-- messages with the REAL LinkedIn send time and a per-message LinkedIn id)
-- instead of deriving messages from campaign action results, whose sent_at was
-- the time the LH2 action ran. Three additive columns carry that provenance:
--
--   external_id  — 'li:<LinkedIn message id>' when LH2 recorded one, otherwise
--                  'lh:<lh.db messages.id>'; unique per instance, so a re-sync
--                  or a re-scrape of the same thread lands on the same row and
--                  an edited message updates instead of duplicating;
--   platform     — the LinkedIn inbox the chat lives in;
--   message_type — LH2's own row type (DEFAULT, MEMBER_TO_MEMBER, EDITED,
--                  RECALLED), kept for diagnosis, never for product logic.
--
-- The legacy identity key (instance, profile, direction, sent_at, content_hash)
-- stays: rows from older agents, per-notebook mapping overrides, CSV ingest and
-- manual imports have no external id and keep using it. The ingest gateway
-- adopts a legacy row into its chat-store identity (setting external_id and the
-- real sent_at) rather than inserting beside it, so sentiment, intent and
-- notification bookkeeping written against the old row survive the switch.
--
-- Additive only: no grant changes (app_machine already holds SELECT/INSERT/UPDATE
-- on messages from step 009, and its instance-scoped policy bounds the rows), no
-- view changes, no DELETE capability.

SET ROLE app_owner;

ALTER TABLE public.messages
    ADD COLUMN external_id text,
    ADD COLUMN platform text,
    ADD COLUMN message_type text,
    ADD CONSTRAINT messages_external_id_length CHECK (
        external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 128
    ),
    ADD CONSTRAINT messages_platform_check CHECK (
        platform IS NULL OR platform IN ('linkedin', 'sales_navigator', 'recruiter')
    ),
    ADD CONSTRAINT messages_message_type_length CHECK (
        message_type IS NULL OR char_length(message_type) <= 40
    );

-- Partial: legacy rows have no external id and must not collide with each other.
CREATE UNIQUE INDEX messages_external_id_key
    ON public.messages (instance_id, external_id)
    WHERE external_id IS NOT NULL;
