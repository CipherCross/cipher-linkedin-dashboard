-- Scope the annotations unique key.
--
-- annotations were unique on (note, noted_at) only, but each row carries
-- instance_id / campaign_id scope (NULL = applies to all). A global note and a
-- scoped note that happened to share the same text and date collided and overwrote
-- each other. Include the scope columns, treating NULLs as equal (Postgres 15+
-- NULLS NOT DISTINCT) so re-running `agent.py annotate` for a global note still
-- upserts the same row rather than inserting duplicates. The sync agent's annotate
-- on_conflict was updated to match (agent v1.7.2+).

alter table annotations drop constraint if exists annotations_note_noted_at_key;
alter table annotations drop constraint if exists annotations_scope_key;
alter table annotations
  add constraint annotations_scope_key
  unique nulls not distinct (note, noted_at, instance_id, campaign_id);
