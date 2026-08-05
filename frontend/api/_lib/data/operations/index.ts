/**
 * The application operation registry — the allowlist of everything the
 * request path is permitted to ask the database for.
 *
 * This is the *application's* registry. The registries under
 * `frontend/tests/support/` are contract fixtures and deliberately stay there;
 * they exercise the adapter, not the product.
 *
 * Rules for anything added here:
 *
 * 1. One named operation per read. Handlers submit names, never SQL.
 * 2. An operation's optional `authorize` hook may only ever *narrow* what the
 *    database already permits. It is never the authorization decision.
 * 3. **Exactly one actorless operation exists**, and it is the actor resolver.
 *    Anything else that needs data needs an actor first. `APPLICATION_ACTORLESS_OPERATIONS`
 *    is asserted to be that single entry, so a second one cannot be added
 *    quietly.
 *
 * S12 registered no command, because its slice was read-only. S17 registered the
 * first three: the identity write path. They are not general table writes — each
 * is one `SECURITY DEFINER` function that authorizes itself against the canonical
 * tables.
 *
 * S14 registers the first *business* writes, and they are a different kind of
 * thing: plain INSERT/UPDATE/DELETE on relations whose `FOR ALL TO app_runtime`
 * policy re-derives the actor from `app.actor_id`, so the database authorizes
 * every one of them without a function in between. Two exceptions call a
 * step-`003` function because it does something a statement cannot —
 * `delete_manual_message` repairs the milestones an import backfilled, and
 * `apply_follow_up_action` owns the revision check and the replay path.
 *
 * 4. A write that must not come apart from another write is **not** one
 *    operation. It is two, run inside one `DataStore.transaction`. The registry
 *    is a vocabulary, not a place to hide a procedure — see the header of
 *    `pipelineWrites.ts` on the CTE alternative and why it lost.
 */

import { NeonOperationRegistry } from '../neon.js'

import { ACTIVITY_OPERATIONS, dailySeriesOperation } from './activity.js'
import {
  DASHBOARD_OPERATIONS,
  annotationsTimelineOperation,
  campaignsPerformanceOperation,
  campaignsSequenceStepsOperation,
  instancesOverviewOperation,
  syncRecentRunsOperation,
} from './dashboard.js'
import {
  IDENTITY_ADMIN_COMMANDS,
  IDENTITY_OPERATIONS,
  inviteMemberOperation,
  resolveActorOperation,
  setMemberActiveOperation,
  setMemberRoleOperation,
  teamRosterOperation,
} from './identity.js'
import {
  CONVERSATION_OPERATIONS,
  conversationLatestMessageOperation,
  conversationReplyIntentOperation,
  followUpHistoryOperation,
  followUpStateOperation,
} from './conversations.js'
import {
  LEADS_OPERATIONS,
  leadNotesOperation,
  leadsDirectoryOperation,
} from './leads.js'
import {
  LIBRARY_OPERATIONS,
  hypothesesOperation,
  hypothesisCampaignsOperation,
  icpIndustriesOperation,
  icpPersonasOperation,
  icpProfilesOperation,
  savedSearchesOperation,
} from './library.js'
import {
  MESSAGES_OPERATIONS,
  inboundHistoryOperation,
  outboundRecentOperation,
  threadOperation,
} from './messages.js'
import { PIPELINE_OPERATIONS, pipelineEventLogOperation } from './pipeline.js'
import {
  PIPELINE_WRITE_COMMANDS,
  PIPELINE_WRITE_OPERATIONS,
  actorDisplayNameOperation,
  addNoteOperation,
  appendGenderReviewOperation,
  appendStageEventOperation,
  deleteNoteOperation,
  leadDemographicsOperation,
  leadPipelineFieldsOperation,
  setGenderOperation,
  setInstanceConfigOperation,
  setStageOperation,
} from './pipelineWrites.js'
import {
  LIBRARY_WRITE_COMMANDS,
  assignSearchHypothesisOperation,
  deleteHypothesisOperation,
  deleteIcpOperation,
  deleteIndustryOperation,
  deletePersonaOperation,
  deleteSavedSearchOperation,
  insertHypothesisOperation,
  insertIcpOperation,
  insertIndustryOperation,
  insertPersonaOperation,
  insertSavedSearchOperation,
  saveCampaignContextOperation,
  savePlaybookOperation,
  setHypothesisCampaignsOperation,
  updateHypothesisOperation,
  updateIcpOperation,
  updateIndustryOperation,
  updatePersonaOperation,
  updateSavedSearchOperation,
} from './libraryWrites.js'
import {
  CONVERSATION_WRITE_COMMANDS,
  CONVERSATION_WRITE_OPERATIONS,
  applyFollowUpActionOperation,
  backfillMilestonesOperation,
  deleteManualMessageOperation,
  editManualMessageOperation,
  insertImportedMessagesOperation,
  leadForImportOperation,
  lockThreadOperation,
  threadDedupKeysOperation,
} from './conversationWrites.js'
import {
  AI_WRITE_OPERATIONS,
  classifyAutoAdvanceOperation,
  classifyGenderBacklogOperation,
  classifyGenderBatchOperation,
  classifyPendingRepliesOperation,
  classifyReclassifyOperation,
  classifyRemainingCountOperation,
  classifyThreadContextOperation,
  classifyWriteGenderOperation,
  classifyWriteLabelsOperation,
  coachActionableProfilesOperation,
  coachDigestUpsertOperation,
  coachExistingOperation,
  coachHypothesisAssignmentOperation,
  coachHypothesisIcpOperation,
  coachIcpDetailOperation,
  coachIcpPersonasOperation,
  coachIssuesByInstanceOperation,
  coachPlaybookOperation,
  coachUpsertOperation,
} from './aiWrites.js'
import {
  briefingAssignmentsOperation,
  briefingAssignedSearchesOperation,
  briefingCampaignsContextOperation,
  briefingClaimJobOperation,
  briefingEnsureJobOperation,
  briefingFailStageOperation,
  briefingFinishStageOperation,
  briefingHypothesesListOperation,
  briefingInstancesListOperation,
  briefingJobRowOperation,
  briefingPriorOperation,
  briefingRecentAnnotationsOperation,
  briefingResetJobOperation,
  briefingStaleErrorOperation,
  briefingUpsertBriefingOperation,
  briefingWeeklyReferenceOperation,
} from './briefingWrites.js'

export { ACTIVITY_OPERATIONS, type DailyActivityRow } from './activity.js'
export {
  LEADS_OPERATIONS,
  type LeadNoteRow,
  type LeadNotesParams,
  type LeadRow,
  type LeadsDirectoryParams,
} from './leads.js'
export {
  MESSAGES_OPERATIONS,
  type MessageRow,
  type MessagesParams,
  type ThreadMessageRow,
  type ThreadParams,
} from './messages.js'
export {
  CONVERSATION_OPERATIONS,
  type ConversationLatestMessageRow,
  type ConversationParams,
  type ConversationReplyIntentRow,
  type FollowUpEventRow,
  type FollowUpStateRow,
} from './conversations.js'
export {
  LIBRARY_OPERATIONS,
  type HypothesisCampaignRow,
  type HypothesisRow,
  type IcpIndustryRow,
  type IcpPersonaRow,
  type IcpRow,
  type SavedSearchRow,
} from './library.js'
export {
  PIPELINE_OPERATIONS,
  type PipelineEventLogParams,
  type PipelineEventRow,
} from './pipeline.js'
export {
  LIBRARY_WRITE_COMMANDS,
  type AssignSearchParams,
  type CampaignContextResult,
  type EntityIdParams,
  type EntityPatchParams,
  type EntityUpdateParams,
  type EntityWriteResult,
  type SaveCampaignContextParams,
  type SavePlaybookParams,
  type SetHypothesisCampaignsParams,
} from './libraryWrites.js'
export {
  PIPELINE_WRITE_COMMANDS,
  PIPELINE_WRITE_OPERATIONS,
  type ActorDisplayNameParams,
  type ActorDisplayNameRow,
  type AddNoteParams,
  type AppendEventResult,
  type AppendGenderReviewParams,
  type AppendStageEventParams,
  type DeleteNoteParams,
  type DeleteResult,
  type LeadByIdParams,
  type LeadDemographicsRow,
  type LeadNoteResult,
  type LeadPipelineFieldsRow,
  type SetGenderParams,
  type SetGenderResult,
  type SetInstanceConfigParams,
  type SetStageParams,
  type SetStageResult,
  type StageChangedAtMode,
} from './pipelineWrites.js'
export {
  CONVERSATION_WRITE_COMMANDS,
  CONVERSATION_WRITE_OPERATIONS,
  type ApplyFollowUpActionParams,
  type BackfillMilestonesParams,
  type BackfillMilestonesResult,
  type DeleteManualMessageParams,
  type DeleteManualMessageResult,
  type EditManualMessageParams,
  type EditManualMessageResult,
  type FollowUpAction,
  type InsertImportedMessagesParams,
  type LeadForImportParams,
  type LeadForImportRow,
  type ThreadDedupKeyRow,
  type ThreadKeyParams,
} from './conversationWrites.js'
export {
  DASHBOARD_OPERATIONS,
  type AnnotationRow,
  type CampaignMetricsRow,
  type CampaignStepRow,
  type InstanceRow,
  type SyncRunRow,
} from './dashboard.js'
export {
  AI_WRITE_OPERATIONS,
  type ActionableProfileRow,
  type ClassifyParams,
  type CoachIcpPersonaRow,
  type CoachThreadKeyParams,
  type CoachUpsertParams,
  type CoachingRow,
  type DigestUpsertParams,
  type GenderBatchParams,
  type GenderBatchRow,
  type HypothesisAssignmentRow,
  type HypothesisIcpRow,
  type IcpDetailRow,
  type PendingReplyRow,
  type ReclassifyParams,
  type ReclassifyResult,
  type ThreadContextParams,
  type ThreadContextRow,
  type WriteGenderParams,
  type WriteLabelsParams,
} from './aiWrites.js'
export {
  BRIEFING_WRITE_COMMANDS,
  BRIEFING_WRITE_OPERATIONS,
  type BriefingJobRowShape,
  type ClaimJobParams,
  type FailStageParams,
  type FinishStageParams,
  type JobKeyParams,
  type PriorBriefingRow,
  type UpsertBriefingParams,
} from './briefingWrites.js'
export {
  IDENTITY_ADMIN_COMMANDS,
  IDENTITY_OPERATIONS,
  // Re-exported, and still not registered below. See the note on
  // `resolveSelfOperation`: it is S16's live evidence surface, fenced off from
  // the request path by being absent from the allowlist rather than by being
  // deleted.
  resolveSelfOperation,
  type ResolvedIdentity,
  type IdentityAdminResult,
  type InviteMemberParams,
  type SetMemberActiveParams,
  type SetMemberRoleParams,
  type TeamRosterRow,
} from './identity.js'

/**
 * Build the application registry. Exported so a test can build an identical
 * one without reaching for the module-scope store.
 */
export function buildApplicationRegistry(): NeonOperationRegistry {
  const registry = new NeonOperationRegistry()

  registry.registerActorlessQuery(
    IDENTITY_OPERATIONS.resolveActor,
    resolveActorOperation,
  )

  registry.registerQuery(IDENTITY_OPERATIONS.teamRoster, teamRosterOperation)
  registry.registerQuery(ACTIVITY_OPERATIONS.dailySeries, dailySeriesOperation)

  // S13's first DataContext slice.
  registry.registerQuery(
    DASHBOARD_OPERATIONS.instancesOverview,
    instancesOverviewOperation,
  )
  registry.registerQuery(
    DASHBOARD_OPERATIONS.campaignsPerformance,
    campaignsPerformanceOperation,
  )
  registry.registerQuery(
    DASHBOARD_OPERATIONS.campaignsSequenceSteps,
    campaignsSequenceStepsOperation,
  )
  registry.registerQuery(
    DASHBOARD_OPERATIONS.syncRecentRuns,
    syncRecentRunsOperation,
  )
  registry.registerQuery(
    DASHBOARD_OPERATIONS.annotationsTimeline,
    annotationsTimelineOperation,
  )

  // S13's second slice — the two keyset-paginated base-table reads.
  registry.registerQuery(LEADS_OPERATIONS.directory, leadsDirectoryOperation)
  registry.registerQuery(
    MESSAGES_OPERATIONS.inboundHistory,
    inboundHistoryOperation,
  )
  registry.registerQuery(
    MESSAGES_OPERATIONS.outboundRecent,
    outboundRecentOperation,
  )

  // S13's third slice — the medium relations, the sourcing library and the three
  // reads that belonged to a component rather than to `DataContext`.
  registry.registerQuery(PIPELINE_OPERATIONS.eventLog, pipelineEventLogOperation)
  registry.registerQuery(
    CONVERSATION_OPERATIONS.followUpState,
    followUpStateOperation,
  )
  registry.registerQuery(
    CONVERSATION_OPERATIONS.latestMessage,
    conversationLatestMessageOperation,
  )
  registry.registerQuery(
    CONVERSATION_OPERATIONS.replyIntent,
    conversationReplyIntentOperation,
  )
  registry.registerQuery(
    CONVERSATION_OPERATIONS.followUpHistory,
    followUpHistoryOperation,
  )
  registry.registerQuery(MESSAGES_OPERATIONS.thread, threadOperation)
  registry.registerQuery(LEADS_OPERATIONS.notes, leadNotesOperation)
  registry.registerQuery(
    LIBRARY_OPERATIONS.savedSearches,
    savedSearchesOperation,
  )
  registry.registerQuery(LIBRARY_OPERATIONS.icpProfiles, icpProfilesOperation)
  registry.registerQuery(LIBRARY_OPERATIONS.icpPersonas, icpPersonasOperation)
  registry.registerQuery(
    LIBRARY_OPERATIONS.icpIndustries,
    icpIndustriesOperation,
  )
  registry.registerQuery(LIBRARY_OPERATIONS.hypotheses, hypothesesOperation)
  registry.registerQuery(
    LIBRARY_OPERATIONS.hypothesisCampaigns,
    hypothesisCampaignsOperation,
  )

  // S14's two reads, which exist only so a write can build its audit row or its
  // dedup set. They are registered as ordinary queries because that is what they
  // are; both are called from inside a write transaction.
  registry.registerQuery(
    PIPELINE_WRITE_OPERATIONS.leadPipelineFields,
    leadPipelineFieldsOperation,
  )
  registry.registerQuery(
    PIPELINE_WRITE_OPERATIONS.leadDemographics,
    leadDemographicsOperation,
  )
  registry.registerQuery(
    PIPELINE_WRITE_OPERATIONS.actorDisplayName,
    actorDisplayNameOperation,
  )
  registry.registerQuery(
    CONVERSATION_WRITE_OPERATIONS.leadForImport,
    leadForImportOperation,
  )
  registry.registerQuery(
    CONVERSATION_WRITE_OPERATIONS.threadDedupKeys,
    threadDedupKeysOperation,
  )

  registry.registerCommand(IDENTITY_ADMIN_COMMANDS.invite, inviteMemberOperation)
  registry.registerCommand(
    IDENTITY_ADMIN_COMMANDS.setActive,
    setMemberActiveOperation,
  )
  registry.registerCommand(IDENTITY_ADMIN_COMMANDS.setRole, setMemberRoleOperation)

  // S14 — the first *business* writes. Every one of them is a plain table write
  // subject to the relation's `FOR ALL TO app_runtime` policy, except the two
  // that call a step-`003` function (`deleteManualMessage`,
  // `applyFollowUpAction`) and therefore authorize themselves.
  registry.registerCommand(PIPELINE_WRITE_COMMANDS.setStage, setStageOperation)
  registry.registerCommand(
    PIPELINE_WRITE_COMMANDS.appendStageEvent,
    appendStageEventOperation,
  )
  registry.registerCommand(PIPELINE_WRITE_COMMANDS.addNote, addNoteOperation)
  registry.registerCommand(PIPELINE_WRITE_COMMANDS.deleteNote, deleteNoteOperation)
  registry.registerCommand(PIPELINE_WRITE_COMMANDS.setGender, setGenderOperation)
  registry.registerCommand(
    PIPELINE_WRITE_COMMANDS.appendGenderReview,
    appendGenderReviewOperation,
  )
  registry.registerCommand(
    PIPELINE_WRITE_COMMANDS.setInstanceConfig,
    setInstanceConfigOperation,
  )

  registry.registerCommand(
    CONVERSATION_WRITE_COMMANDS.lockThread,
    lockThreadOperation,
  )
  registry.registerCommand(
    CONVERSATION_WRITE_COMMANDS.insertImportedMessages,
    insertImportedMessagesOperation,
  )
  registry.registerCommand(
    CONVERSATION_WRITE_COMMANDS.backfillMilestones,
    backfillMilestonesOperation,
  )
  registry.registerCommand(
    CONVERSATION_WRITE_COMMANDS.editManualMessage,
    editManualMessageOperation,
  )
  registry.registerCommand(
    CONVERSATION_WRITE_COMMANDS.deleteManualMessage,
    deleteManualMessageOperation,
  )
  // Registered, and deliberately not reachable from an endpoint: the roster wall
  // (N-B2) blocks `p_owner_id` while reads stay on Supabase. See the module
  // header and the S14 handoff.
  registry.registerCommand(
    CONVERSATION_WRITE_COMMANDS.applyFollowUpAction,
    applyFollowUpActionOperation,
  )

  // S14's second slice — the sourcing library. Fifteen of these replace the two
  // generic helpers `/api/playbook` dispatched nine actions through; see
  // `libraryWrites.ts` on why a table name may not be a run-time parameter.
  registry.registerCommand(LIBRARY_WRITE_COMMANDS.insertIcp, insertIcpOperation)
  registry.registerCommand(LIBRARY_WRITE_COMMANDS.updateIcp, updateIcpOperation)
  registry.registerCommand(LIBRARY_WRITE_COMMANDS.deleteIcp, deleteIcpOperation)
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.insertPersona,
    insertPersonaOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.updatePersona,
    updatePersonaOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.deletePersona,
    deletePersonaOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.insertIndustry,
    insertIndustryOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.updateIndustry,
    updateIndustryOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.deleteIndustry,
    deleteIndustryOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.insertHypothesis,
    insertHypothesisOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.updateHypothesis,
    updateHypothesisOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.deleteHypothesis,
    deleteHypothesisOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.insertSavedSearch,
    insertSavedSearchOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.updateSavedSearch,
    updateSavedSearchOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.deleteSavedSearch,
    deleteSavedSearchOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.setHypothesisCampaigns,
    setHypothesisCampaignsOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.assignSearchHypothesis,
    assignSearchHypothesisOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.saveCampaignContext,
    saveCampaignContextOperation,
  )
  registry.registerCommand(
    LIBRARY_WRITE_COMMANDS.savePlaybook,
    savePlaybookOperation,
  )

  // S15 — the AI layer's HUMAN-ACTOR half. The guard reads run as app_system
  // in the separate AI registry (`operations/ai.ts`); everything registered
  // here has a signed-in actor and runs as app_runtime in this shared store,
  // under the same active-member policies as S14's writes. The cron halves of
  // these handlers are not here: they have no actor, and stay declared
  // blocked until ledger step 007 is applied.
  registry.registerQuery(AI_WRITE_OPERATIONS.coachExisting, coachExistingOperation)
  registry.registerQuery(AI_WRITE_OPERATIONS.coachPlaybook, coachPlaybookOperation)
  registry.registerQuery(
    AI_WRITE_OPERATIONS.coachHypothesisAssignment,
    coachHypothesisAssignmentOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.coachHypothesisIcp,
    coachHypothesisIcpOperation,
  )
  registry.registerQuery(AI_WRITE_OPERATIONS.coachIcpDetail, coachIcpDetailOperation)
  registry.registerQuery(
    AI_WRITE_OPERATIONS.coachIcpPersonas,
    coachIcpPersonasOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.coachActionableProfiles,
    coachActionableProfilesOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.coachIssuesByInstance,
    coachIssuesByInstanceOperation,
  )
  registry.registerCommand(AI_WRITE_OPERATIONS.coachUpsert, coachUpsertOperation)
  registry.registerCommand(
    AI_WRITE_OPERATIONS.coachDigestUpsert,
    coachDigestUpsertOperation,
  )

  registry.registerQuery(
    AI_WRITE_OPERATIONS.classifyPendingReplies,
    classifyPendingRepliesOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.classifyThreadContext,
    classifyThreadContextOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.classifyRemainingCount,
    classifyRemainingCountOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.classifyGenderBatch,
    classifyGenderBatchOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.classifyGenderBacklog,
    classifyGenderBacklogOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.classifyWriteLabels,
    classifyWriteLabelsOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.classifyWriteGender,
    classifyWriteGenderOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.classifyReclassify,
    classifyReclassifyOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.classifyAutoAdvance,
    classifyAutoAdvanceOperation,
  )

  registry.registerQuery(AI_WRITE_OPERATIONS.briefingJobRow, briefingJobRowOperation)
  registry.registerQuery(AI_WRITE_OPERATIONS.briefingPrior, briefingPriorOperation)
  registry.registerQuery(
    AI_WRITE_OPERATIONS.briefingWeeklyReference,
    briefingWeeklyReferenceOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.briefingCampaignsContext,
    briefingCampaignsContextOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.briefingInstancesList,
    briefingInstancesListOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.briefingHypothesesList,
    briefingHypothesesListOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.briefingAssignments,
    briefingAssignmentsOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.briefingAssignedSearches,
    briefingAssignedSearchesOperation,
  )
  registry.registerQuery(
    AI_WRITE_OPERATIONS.briefingRecentAnnotations,
    briefingRecentAnnotationsOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingEnsureJob,
    briefingEnsureJobOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingClaimJob,
    briefingClaimJobOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingFinishStage,
    briefingFinishStageOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingFailStage,
    briefingFailStageOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingResetJob,
    briefingResetJobOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingStaleError,
    briefingStaleErrorOperation,
  )
  registry.registerCommand(
    AI_WRITE_OPERATIONS.briefingUpsertBriefing,
    briefingUpsertBriefingOperation,
  )

  return registry
}

/** Every actor-scoped read the application may perform, for assertions. */
export const APPLICATION_QUERY_OPERATIONS = [
  IDENTITY_OPERATIONS.teamRoster,
  ACTIVITY_OPERATIONS.dailySeries,
  DASHBOARD_OPERATIONS.instancesOverview,
  DASHBOARD_OPERATIONS.campaignsPerformance,
  DASHBOARD_OPERATIONS.campaignsSequenceSteps,
  DASHBOARD_OPERATIONS.syncRecentRuns,
  DASHBOARD_OPERATIONS.annotationsTimeline,
  LEADS_OPERATIONS.directory,
  MESSAGES_OPERATIONS.inboundHistory,
  MESSAGES_OPERATIONS.outboundRecent,
  PIPELINE_OPERATIONS.eventLog,
  CONVERSATION_OPERATIONS.followUpState,
  CONVERSATION_OPERATIONS.latestMessage,
  CONVERSATION_OPERATIONS.replyIntent,
  CONVERSATION_OPERATIONS.followUpHistory,
  MESSAGES_OPERATIONS.thread,
  LEADS_OPERATIONS.notes,
  LIBRARY_OPERATIONS.savedSearches,
  LIBRARY_OPERATIONS.icpProfiles,
  LIBRARY_OPERATIONS.icpPersonas,
  LIBRARY_OPERATIONS.icpIndustries,
  LIBRARY_OPERATIONS.hypotheses,
  LIBRARY_OPERATIONS.hypothesisCampaigns,
  PIPELINE_WRITE_OPERATIONS.leadPipelineFields,
  PIPELINE_WRITE_OPERATIONS.leadDemographics,
  PIPELINE_WRITE_OPERATIONS.actorDisplayName,
  CONVERSATION_WRITE_OPERATIONS.leadForImport,
  CONVERSATION_WRITE_OPERATIONS.threadDedupKeys,
  AI_WRITE_OPERATIONS.coachExisting,
  AI_WRITE_OPERATIONS.coachPlaybook,
  AI_WRITE_OPERATIONS.coachHypothesisAssignment,
  AI_WRITE_OPERATIONS.coachHypothesisIcp,
  AI_WRITE_OPERATIONS.coachIcpDetail,
  AI_WRITE_OPERATIONS.coachIcpPersonas,
  AI_WRITE_OPERATIONS.coachActionableProfiles,
  AI_WRITE_OPERATIONS.coachIssuesByInstance,
  AI_WRITE_OPERATIONS.classifyPendingReplies,
  AI_WRITE_OPERATIONS.classifyThreadContext,
  AI_WRITE_OPERATIONS.classifyRemainingCount,
  AI_WRITE_OPERATIONS.classifyGenderBatch,
  AI_WRITE_OPERATIONS.classifyGenderBacklog,
  AI_WRITE_OPERATIONS.briefingJobRow,
  AI_WRITE_OPERATIONS.briefingPrior,
  AI_WRITE_OPERATIONS.briefingWeeklyReference,
  AI_WRITE_OPERATIONS.briefingCampaignsContext,
  AI_WRITE_OPERATIONS.briefingInstancesList,
  AI_WRITE_OPERATIONS.briefingHypothesesList,
  AI_WRITE_OPERATIONS.briefingAssignments,
  AI_WRITE_OPERATIONS.briefingAssignedSearches,
  AI_WRITE_OPERATIONS.briefingRecentAnnotations,
] as const

/**
 * Every write. The first three are the identity write path and are not table
 * writes; the rest are S14's business writes.
 */
export const APPLICATION_COMMAND_OPERATIONS = [
  IDENTITY_ADMIN_COMMANDS.invite,
  IDENTITY_ADMIN_COMMANDS.setActive,
  IDENTITY_ADMIN_COMMANDS.setRole,
  PIPELINE_WRITE_COMMANDS.setStage,
  PIPELINE_WRITE_COMMANDS.appendStageEvent,
  PIPELINE_WRITE_COMMANDS.addNote,
  PIPELINE_WRITE_COMMANDS.deleteNote,
  PIPELINE_WRITE_COMMANDS.setGender,
  PIPELINE_WRITE_COMMANDS.appendGenderReview,
  PIPELINE_WRITE_COMMANDS.setInstanceConfig,
  CONVERSATION_WRITE_COMMANDS.lockThread,
  CONVERSATION_WRITE_COMMANDS.insertImportedMessages,
  CONVERSATION_WRITE_COMMANDS.backfillMilestones,
  CONVERSATION_WRITE_COMMANDS.editManualMessage,
  CONVERSATION_WRITE_COMMANDS.deleteManualMessage,
  CONVERSATION_WRITE_COMMANDS.applyFollowUpAction,
  LIBRARY_WRITE_COMMANDS.insertIcp,
  LIBRARY_WRITE_COMMANDS.updateIcp,
  LIBRARY_WRITE_COMMANDS.deleteIcp,
  LIBRARY_WRITE_COMMANDS.insertPersona,
  LIBRARY_WRITE_COMMANDS.updatePersona,
  LIBRARY_WRITE_COMMANDS.deletePersona,
  LIBRARY_WRITE_COMMANDS.insertIndustry,
  LIBRARY_WRITE_COMMANDS.updateIndustry,
  LIBRARY_WRITE_COMMANDS.deleteIndustry,
  LIBRARY_WRITE_COMMANDS.insertHypothesis,
  LIBRARY_WRITE_COMMANDS.updateHypothesis,
  LIBRARY_WRITE_COMMANDS.deleteHypothesis,
  LIBRARY_WRITE_COMMANDS.insertSavedSearch,
  LIBRARY_WRITE_COMMANDS.updateSavedSearch,
  LIBRARY_WRITE_COMMANDS.deleteSavedSearch,
  LIBRARY_WRITE_COMMANDS.setHypothesisCampaigns,
  LIBRARY_WRITE_COMMANDS.assignSearchHypothesis,
  LIBRARY_WRITE_COMMANDS.saveCampaignContext,
  LIBRARY_WRITE_COMMANDS.savePlaybook,
  AI_WRITE_OPERATIONS.coachUpsert,
  AI_WRITE_OPERATIONS.coachDigestUpsert,
  AI_WRITE_OPERATIONS.classifyWriteLabels,
  AI_WRITE_OPERATIONS.classifyWriteGender,
  AI_WRITE_OPERATIONS.classifyReclassify,
  AI_WRITE_OPERATIONS.classifyAutoAdvance,
  AI_WRITE_OPERATIONS.briefingEnsureJob,
  AI_WRITE_OPERATIONS.briefingClaimJob,
  AI_WRITE_OPERATIONS.briefingFinishStage,
  AI_WRITE_OPERATIONS.briefingFailStage,
  AI_WRITE_OPERATIONS.briefingResetJob,
  AI_WRITE_OPERATIONS.briefingStaleError,
  AI_WRITE_OPERATIONS.briefingUpsertBriefing,
] as const

/**
 * The complete actorless surface. One entry, and a test asserts the count — a
 * read that runs with no actor published is the sharpest tool in the driver and
 * it exists for exactly one reason.
 */
export const APPLICATION_ACTORLESS_OPERATIONS = [
  IDENTITY_OPERATIONS.resolveActor,
] as const
