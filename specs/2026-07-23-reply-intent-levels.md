# Reply intent levels (P1–P3)

## Goal
Separate commercial intent from the existing broad reply sentiment so that polite encouragement, substantive problem interest, and genuine buying intent are not reported as one “Positive” number. Introduce P1/P2/P3 intent classification, make P3 the denominator for booking conversion, and define a chronology-aware P3 ghosting metric that reflects real follow-up outcomes.

## Non-goals
- Do not replace the existing sentiment taxonomy (`positive`, `neutral`, `negative`, `objection`, `referral`, `auto`); intent is a separate dimension.
- Do not automatically advance CRM pipeline stages from P1, P2, or P3.
- Do not change the existing general `following_up` automation or the existing 30-day AI definition of true ghosting for non-P3 conversations.
- Do not infer a booked call from reply text. `call_booked` remains a manually recorded CRM milestone.
- Do not change Linked Helper extraction or sync-agent message identity/deduplication.

## Research findings
- Reply classification currently lives on each inbound `messages` row as a flat sentiment. The classifier in `frontend/api/classify.ts` already describes polite thanks as neutral, substantive questions as objections, and call/info requests as positive, so the requested P1–P3 model cannot be represented reliably by renaming `positive`.
- Sentiment is used at several different grains: per message in trends, latest inbound reply per conversation in lead filters/KPIs, and deduplicated lead/cohort rows in Manager Review. P3 conversion needs one consistent conversation-level milestone and aligned timestamps.
- A later reply currently replaces the “latest sentiment” used for a lead. Buying intent must instead be durable: once a conversation reaches P3, later acknowledgements cannot erase that milestone.
- Booked calls are already represented by the `call_booked` pipeline stage and `pipeline_events`. There is no existing positive-to-booking conversion; P3-to-booking is a new metric.
- Existing ghosting behavior is chronology-based. A credible P3 ghosting calculation must require a post-P3 outbound follow-up and subsequent silence, not merely “P3 without a booking.”
- Existing rows with non-null sentiment are skipped by the classifier, so historical reporting requires an explicit backfill. Manual sentiment corrections are marked with `classified_model='manual'` and need to remain distinguishable.
- The classifier has structured output but no golden evaluation dataset, prompt/taxonomy version, or per-class quality report. P3 will be rarer and business-critical, making per-class precision especially important.
- Anthropic’s classifier guidance recommends explicit class boundaries, diverse examples, and task-specific evaluation. For imbalanced classes, per-class precision/recall and a confusion matrix are more useful than aggregate accuracy.

## Decisions
- Keep sentiment and intent orthogonal. Add nullable intent `P1`, `P2`, or `P3` to inbound replies rather than replacing existing sentiment values.
- For mixed replies, apply the highest demonstrated intent: P3 takes precedence over P2, which takes precedence over P1. Sentiment remains independent; for example, an objection can also be P3.
- Store intent per message and derive a durable conversation milestone from the first time the conversation reaches P3. Later lower-intent messages do not erase prior P3 intent.
- Define booking conversion as: unique conversations that enter `call_booked` after their first P3 message divided by unique conversations that ever reach P3.
- Attribute the conversion to the campaign attached to the first P3 message. Expose both an all-time/raw rate and a mature-cohort rate whose P3 denominator is at least 14 days old.
- Define P3 ghosting as: the conversation reached P3, has a recorded outbound message after P3, has not subsequently booked, and has received no later inbound reply for at least 30 days.
- Do not auto-advance CRM stages based on P1/P2/P3.
- Backfill all historical non-auto inbound replies. Reclassify AI-owned rows under the new joint rubric; preserve manually chosen sentiment while automatically assigning P1/P2/P3 intent to manual rows.

## Approach
Add intent-specific fields to `messages` rather than overloading `sentiment`. Alongside the nullable intent value, store intent classification metadata (reason, model/manual source, classified timestamp, and taxonomy version) so backfills and future rubric changes remain auditable. Keep the existing sentiment fields and constraints compatible throughout deployment.

Update the Haiku classifier to return both sentiment and intent from one structured decision. The prompt will define hard boundaries:
- P1: positive/polite acknowledgement with no demonstrated problem exploration or next-step intent.
- P2: discusses the relevant problem, context, constraints, or asks substantive qualifying questions, but does not request or accept a concrete buying step.
- P3: asks for or accepts a call, scheduling, proposal, pricing/process/timeline needed to proceed, or otherwise expresses readiness for a concrete commercial next step.
- No intent: negative, automated, irrelevant, or purely neutral replies without a positive commercial signal.

For mixed content, the classifier selects the highest supported intent while independently retaining the appropriate sentiment. Examples will explicitly cover objection + call request, pricing questions, “send details,” deferrals, referrals, polite thanks, and multilingual replies.

Add one controlled historical backfill path to classify rows by taxonomy version. AI-classified rows may receive refreshed sentiment and intent; manually classified rows retain their sentiment and receive only intent metadata. Automated replies remain without a P-level. The job must be resumable, batched, idempotent, and report counts/failures without disturbing sync.

Centralize intent vocabulary, labels, colors, ordering, and conversation-level derivations in the client data library. Expose per-message intent in the conversation drawer with manual correction controls. Leads filters and badges should show intent separately from sentiment, and any aggregate “Positive” display should be replaced by or clearly decomposed into P1/P2/P3 so the broad total cannot be mistaken for buying intent.

Create shared analytics derivations for:
- unique conversations reaching P1, P2, and P3;
- first-P3 timestamp and campaign;
- raw and 14-day-mature P3-to-booked conversion, requiring booking chronology after P3;
- P3 ghosting using the agreed post-P3 outbound and 30-day silence rules.

Use the same definitions in overview/account/campaign KPIs, Manager Review, exports/digests, and AI schema guidance. Preserve the existing per-message sentiment trend, adding a separate intent trend or intent breakdown rather than mixing two taxonomies in one chart.

## Implementation phases
1. **Schema and shared taxonomy — M**
   - Add a new sequential Supabase migration after `046` with intent value and audit metadata on `messages`, constraints/indexes, and any read-only views needed for consistent conversation-level P3 milestones.
   - Add shared TypeScript intent types, metadata, formatting, and null-safe migration compatibility.
   - Update `SCHEMA_DOC` so Chat, MCP, and briefings understand the new dimension and exact conversion/ghosting definitions.

2. **Classifier, correction UI, and evaluation fixture — M**
   - Extend structured classifier output and prompting to produce independent sentiment and intent with explicit precedence and representative examples.
   - Extend manual reclassification and the conversation drawer to display/edit intent independently.
   - Add a versioned golden dataset covering P1/P2/P3/no-intent, mixed signals, objections, referrals, deferrals, automated replies, and the languages seen in production.
   - Add a repeatable evaluation script/report with per-class precision, recall, F1, support, and confusion matrix; prioritize P3 precision.

3. **Historical backfill — M**
   - Add a guarded, batched, resumable backfill mode that targets rows missing the current intent taxonomy version.
   - Reclassify AI-owned historical rows jointly; preserve manual sentiment while assigning intent to manual rows.
   - Dry-run first and report old sentiment versus new intent distributions, with special attention to the current 56-positive population.

4. **Conversation-level metrics — L**
   - Implement first/ever P3 derivation keyed by `(instance_id, profile_url)` and attributed to the first-P3 campaign without leaking across instances or double-counting repeated campaign rows.
   - Join P3 chronology to `pipeline_events`/current pipeline state to compute bookings strictly after P3.
   - Implement raw and 14-day-mature P3 booking conversion plus agreed P3 ghosting.
   - Cover multi-campaign contacts, later lower-intent messages, missing pipeline history, same-day events, and absent outbound follow-up.

5. **Dashboard and review surfaces — L**
   - Replace ambiguous Positive KPI presentations with P1/P2/P3 breakdowns and make P3 the explicit commercial-intent KPI.
   - Add raw/mature P3-to-booked conversion and P3 ghosting with denominator/tool-tip definitions.
   - Update lead filters, badges, account/campaign details, Manager Review tables, CSV exports, digest totals, and warm-thread callouts.
   - Keep sentiment and intent visually distinct and avoid adding P1–P3 as three more peer buttons to the already crowded sentiment control.

6. **AI analytics, documentation, and rollout verification — M**
   - Update briefing prompts/seed queries, review digest language, shared Slack formatting, README, and repository architecture notes.
   - Deploy schema before classifier/UI, run the evaluation gate, execute a dry-run backfill, then run the real backfill.
   - Compare sampled classifications and P3/booked counts against manually reviewed production conversations before treating the metric as authoritative.

## Affected files/modules
- New `supabase/migrations/047_*.sql`
- `frontend/api/classify.ts`
- `frontend/api/reclassify.ts`
- `frontend/api/_lib/core.ts`
- `frontend/api/briefing.ts`
- `frontend/api/review-digest.ts`
- `frontend/api/_lib/slack.ts`
- `frontend/src/lib/types.ts`
- `frontend/src/lib/leads.ts`
- `frontend/src/lib/review.ts`
- `frontend/src/lib/pipeline.ts`
- `frontend/api/_lib/pipeline.ts`
- `frontend/src/contexts/DataContext.tsx`
- `frontend/src/components/ConversationDrawer.tsx`
- `frontend/src/components/KpiCards.tsx`
- `frontend/src/components/AccountCard.tsx`
- `frontend/src/components/SentimentTrendChart.tsx`
- `frontend/src/components/ImportCalloutCard.tsx`
- `frontend/src/pages/LeadsExplorer.tsx`
- Overview, Account Detail, Campaign Detail, and Review page modules
- `frontend/src/styles.css`
- `frontend/src/App.tsx` legacy type cleanup
- New classifier fixture/evaluation files under `frontend/`
- `README.md`, `AGENTS.md`, and `CLAUDE.md`

## Risks & how to verify
- **P1/P2 overlap with neutral/objection:** Verify with a manually labelled golden set and explicit mixed-signal examples; inspect the confusion matrix rather than aggregate accuracy.
- **False P3 inflates ghosting and depresses conversion:** Set a P3 precision gate before rollout and manually audit a sample of predicted P3 replies, including all disagreement cases in the initial backfill sample.
- **Historical discontinuity:** Store taxonomy version/source and publish pre/post distribution counts. Preserve manual sentiment and make backfill resumable.
- **Conversation/campaign double-counting:** Test the same profile across instances and campaigns. Confirm conversation uniqueness is instance-scoped and attribution is fixed at first P3.
- **Chronology errors:** Test bookings before versus after P3, later lower-intent replies, outbound follow-up presence, subsequent inbound replies, and exact 14/30-day boundaries in UTC.
- **Migration/deployment skew:** Apply the additive nullable schema first; keep readers tolerant of null intent; only then deploy writers and UI.
- **Incomplete manual CRM/history data:** Label P3 conversion as based on recorded bookings and retain existing import-history warnings.
- **Dashboard crowding or semantic ambiguity:** Separate sentiment controls from intent controls and include concise definitions in KPI tooltips/exports.
- **Regression in existing CRM behavior:** Verify no P-level trigger advances stages and existing `following_up` automation remains unchanged.
- **Build correctness:** Run the frontend production build after TypeScript changes and verify classification, reclassification, filtering, KPI, review export, briefing, and Slack digest paths.

## Definition of done
- Every eligible inbound reply can store an independent P1/P2/P3 intent with auditable classification metadata and taxonomy version.
- The classifier follows the agreed precedence and passes the approved golden-set quality gate, with P3 precision reported separately.
- Historical AI and manual replies are backfilled according to the agreed preservation rules, with dry-run and completion reports.
- A conversation retains an ever/first-P3 milestone even when later replies have lower intent.
- Booking conversion counts only recorded bookings after P3, offers raw and 14-day-mature rates, and uses unique instance-scoped conversations.
- P3 ghosting requires post-P3 outbound follow-up, no later booking, and 30 days without a subsequent inbound reply.
- No P-level automatically changes CRM stage.
- Overview, account, campaign, leads, review/export/digest, and conversation surfaces distinguish P1/P2/P3 and no longer present all positive intent as one misleading commercial KPI.
- Chat/MCP schema knowledge, briefings, Slack outputs, and repository documentation use the same definitions.
- The migration applies cleanly, the frontend production build succeeds, and sampled production results match manual review.
