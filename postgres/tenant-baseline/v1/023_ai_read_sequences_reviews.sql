-- Step 023: the AI SQL sandbox may read reply reviews, contact names and the
-- Sequence Builder's copy and deployment lineage.
--
-- Every table added after step 010 was left outside app_ai_runner's SELECT
-- allowlist. For three groups that is now a defect rather than a boundary:
--
-- * reply_reviews (step 017) is the source of truth for the team's manual
--   sentiment and P1-P3 intent labels. The AI schema doc already tells the model
--   to use it and two briefing seed queries join it, so both fail on permission
--   and every briefing runs without the labels.
-- * conversation_contacts (step 022) names the two thirds of inbound threads that
--   have no lead row; without it the AI sees only a profile identifier.
-- * sequence_documents/_versions, sequence_publish_jobs/_branches and
--   campaign_sequence_links (steps 011-013) hold every step variation and A/B/C
--   branch the team wrote and which campaign each was published to. The synced
--   campaign_steps table keeps only LH2's first variant.
--
-- Same shape as step 003's AI grants: SELECT only, one FOR SELECT policy per
-- relation, USING (true) because the AI path reads the shared workspace without
-- an actor. Publish lineage is column-scoped: claim leases, machine keys,
-- credential ids, idempotency keys and verification payloads are machine
-- plumbing and stay invisible. Still excluded: comments, publish targets and
-- contracts, review events/mutations, legacy classifications, identity.

SET ROLE app_owner;

GRANT SELECT ON TABLE
    public.reply_reviews,
    public.reply_review_reasons,
    public.conversation_reply_review_state,
    public.conversation_contacts,
    public.sequence_documents,
    public.sequence_versions
    TO app_ai_runner;

GRANT SELECT(id, sequence_document_id, sequence_revision, sequence_version_id, sequence_name,
             document_snapshot, target_instance_id, status, queued_at, finished_at, error_code)
    ON TABLE public.sequence_publish_jobs TO app_ai_runner;
GRANT SELECT(job_id, branch_id, branch_ordinal, branch_letter, campaign_name,
             compiled_action_chain, status, lh_campaign_id, finished_at)
    ON TABLE public.sequence_publish_branches TO app_ai_runner;
GRANT SELECT(id, campaign_id, sequence_document_id, link_kind, linked_by_name, linked_at)
    ON TABLE public.campaign_sequence_links TO app_ai_runner;

CREATE POLICY reply_reviews_ai_read ON public.reply_reviews FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY reply_review_reasons_ai_read ON public.reply_review_reasons FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY conversation_reply_review_state_ai_read ON public.conversation_reply_review_state FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY conversation_contacts_ai_read ON public.conversation_contacts FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY sequence_documents_ai_read ON public.sequence_documents FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY sequence_versions_ai_read ON public.sequence_versions FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY sequence_publish_jobs_ai_read ON public.sequence_publish_jobs FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY sequence_publish_branches_ai_read ON public.sequence_publish_branches FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY campaign_sequence_links_ai_read ON public.campaign_sequence_links FOR SELECT TO app_ai_runner USING (true);

RESET ROLE;
