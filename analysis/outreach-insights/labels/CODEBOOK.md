# Reply classification codebook (analysis-only)

Context: a software agency does LinkedIn outreach, mostly to founders and executives at small
health, wellness and health-tech companies. It offers mobile app development ("Web2Mob": turning
a web product into a mobile app), app modernization, outstaffed developers, UX/UI, full-stack and
QA services. `[US …]` lines are the agency's messages, `[THEM …]` lines are the lead's.

Label every thread in the batch. Judge only from the transcript. Do not invent facts.

## Fields

- `first_reply`: the type of the lead's FIRST `[THEM]` message, read in the context of the
  `[US]` message right before it. Exactly one of:
  - `interested`: wants to talk, agrees to a call, asks for a proposal or deck with clear
    interest, or describes a current need that matches the offer.
  - `question`: asks what the agency does, about pricing, details or how it works. Curious, no
    commitment.
  - `polite`: thanks, "nice to connect", compliments, small talk. No interest or rejection signal.
  - `not_now`: a timing objection: busy, maybe later, revisit in N months, not at this stage.
  - `not_interested`: no thanks, not relevant, not a fit, stop or unsubscribe, annoyed.
  - `has_solution`: already has a team, vendor, in-house developers, an agency or a finished product.
  - `referral`: points to another person, or says they are not the decision maker.
  - `pitch_back`: pitches their own product or services, asks for a job, recruits, or proposes a
    partnership on their terms.
  - `auto_reply`: out of office, autoresponder, automated message.
  - `other`: none of the above fits (explain in `note`).
- `best_intent`: the most advanced commercial intent across ALL `[THEM]` messages:
  - `none`: no commercial intent (rejection, small talk only, auto-reply, pitch-back).
  - `p1`: a polite positive acknowledgement of the offer without substance ("sounds interesting",
    "thanks, will keep in mind").
  - `p2`: substantive interest in the problem, or qualifying questions (what they need, their
    situation, how the agency works, asks for examples or case studies).
  - `p3`: concrete buying intent: a call or meeting requested or accepted, scheduling, asks for a
    proposal or pricing for their project, process or timeline needed to proceed.
  An objection can still be p3 if they also agree to a call.
- `call_agreed`: true only if the lead agreed to a call or meeting, or a time or booking link was
  accepted. Otherwise false.
- `ended_negative`: true if the lead's LAST `[THEM]` message is a rejection (`not_interested`,
  `has_solution` or a clear no). Otherwise false.
- `rapport`: true if the thread is mainly personal or social warmth (life, location, shared
  interests) rather than business.
- `language`: an ISO 639-1 code of the lead's messages (for example `en`, `de`, `uk`).
- `confidence`: `high`, `medium` or `low` for `first_reply` and `best_intent` together.
- `note`: at most 15 words of rationale, in English. Never copy names or contact details.

## Output

Write one JSON object per input thread, one per line (JSONL), in the same order as the input,
keeping `thread_id` exactly:

{"thread_id": "...", "first_reply": "...", "best_intent": "...", "call_agreed": false, "ended_negative": false, "rapport": false, "language": "en", "confidence": "high", "note": "..."}
