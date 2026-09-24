/**
 * The English UI vocabulary.
 *
 * Raw enum and API values are unchanged — this maps them to what a person
 * reads. It replaced a mixed-language surface: the Replies review panel and the
 * whole Sentiment Analysis page rendered in Russian inside an otherwise English
 * shell, Leads offered an "Открыть Replies" link, and dates arrived in three
 * locales. User-generated content — message bodies, campaign names, playbooks,
 * people's names — is never translated by anything here.
 */

export const SENTIMENT_LABELS: Record<string, string> = {
  positive: 'Positive',
  neutral: 'Neutral',
  negative: 'Negative',
  auto: 'Automated reply',
}

export const INTENT_LEVEL_LABELS: Record<string, string> = {
  p1: 'P1 · Polite positive',
  p2: 'P2 · Problem interest',
  p3: 'P3 · Buying intent',
}

export const INTENT_STATE_LABELS: Record<string, string> = {
  unreviewed: 'Not reviewed',
  none: 'None',
  level: 'Level',
  not_applicable: 'Not applicable',
}

/** Copy that appears verbatim in more than one place. */
export const COPY = {
  replies: 'Replies',
  all: 'All',
  unreviewed: 'Unreviewed',
  needsReply: 'Needs reply',
  deferred: 'Deferred',
  completed: 'Completed',
  reviewReply: 'Review reply',
  sentiment: 'Sentiment',
  reasons: 'Reasons',
  buyingInterest: 'Buying interest',
  nextStep: 'Next step',
  conversationOwner: 'Conversation owner',
  doNotContact: 'Do not contact',
  save: 'Save',
  saveAndNext: 'Save and next',
  saving: 'Saving…',
  saved: 'Changes saved',
  saveFailed: 'Could not save. Try again.',
  clearFilters: 'Clear filters',
  clearAll: 'Clear all',
  apply: 'Apply',
  cancel: 'Cancel',
  filters: 'Filters',
  refresh: 'Refresh',
  retry: 'Retry',
  loading: 'Loading…',
  noChanges: 'No changes',
  unsavedChanges: 'Unsaved changes',
  noResults: 'No results match the current filters.',
  noData: 'No data yet.',
} as const
