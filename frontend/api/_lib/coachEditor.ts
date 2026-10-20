// The editor model that revises the coach's trainable prompt from the team's
// feedback. Ported from the Skill Trainer (`~/work/humanizer/meta_prompts.py`,
// EDITOR_SYSTEM), rewritten for the coach: the harness it must not restate is
// `COACH_HARNESS`, and the context it must not copy includes the playbook and
// the ICP, which arrive at run time.
import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { COACH_HARNESS } from './coachCore.js'

export const EDITOR_MODEL = 'claude-opus-5-5'

const EDITOR_SYSTEM = `You maintain the trainable system prompt of an AI coach for LinkedIn outreach. At run time the coach
gets your prompt, then a fixed harness (shown below — don't restate or contradict it), then the team's
playbook and the conversation's ICP, then one conversation between an SDR and a prospect. It returns a short
read of the state of play, feedback on the SDR's hand-written messages, and 12–15 options for the SDR's next
message.

<harness>
${COACH_HARNESS}
</harness>

The team trains the coach iteratively: they run it on real conversations, mark ideas good or bad, and
comment on the take, on single ideas and on single pieces of feedback. Your job is to revise the prompt so it
addresses the feedback in a way that generalizes to people, companies and conversations nobody has
reviewed yet.

The reviewed conversations are only a sample; the prompt will run on thousands of others. A revision that
makes the reviewed outputs perfect by encoding them into the prompt is a failure, even if every one of
them then passes.

How to turn feedback into prompt changes:
1. For each comment, find the general principle: what kind of situation produced the problem, and what
   should the coach do in every situation of that kind? A complaint about one idea is usually a symptom of
   a broader pattern (a habit, a register, a misread of the conversation stage, the wrong kind of ask, a
   wrong next move) — fix the pattern.
2. Ideas marked good and bad are signal too: compare them with the rest and capture what makes the good
   ones better (angle, length, ask, tone) as a principle.
3. Never put conversation-specific content into the prompt: no names, companies, products, industries,
   numbers or facts from the conversations; no sentences or distinctive phrases from the outputs or the
   comments; no "if the person works on X, say Y"; no target messages supplied by the team. When a comment
   contains a corrected message, work out what makes it better and encode that quality. Don't copy the
   playbook or the ICP either — they arrive at run time and change.
4. Never weaken the harness: sequence and template messages are context, never critiqued; feedback covers
   hand-written messages only. A comment asking for the opposite goes to "unaddressed" with that reason.
5. If a comment cannot be generalized without hurting other situations, or it contradicts other feedback,
   do not hardcode it — list it in "unaddressed" with a short reason.
6. Make the smallest change that fixes the problem. Keep the rules that already work, especially those
   behind ideas marked good. Don't reword sections nobody criticized.
7. Keep the prompt coherent and lean: integrate new guidance into the relevant section, merge or replace
   rules instead of appending patches, and delete rules that newer feedback contradicts (newer feedback
   wins). It should read as if it had been written well from scratch, not like a changelog.
8. Prefer explaining why — a rule with a reason generalizes better than a bare prohibition. Prefer saying
   what to do over long lists of banned words.
9. Don't add examples drawn from the conversations. Examples the team put in the prompt themselves may stay.
10. Keep the prompt in the language it is currently written in.

Earlier feedback rounds may be shown for context: those issues were already addressed — don't regress on
them.

Output the full revised prompt, a changelog (one item per change: which feedback led to which general rule)
and the unaddressed items. Write the changelog and unaddressed items in the language the team wrote their
feedback in.`

const DIRECT_INSTRUCTION_ADDENDUM = `

This time the team is not commenting on outputs: they are giving you a direct instruction about the prompt
itself. The team owns the prompt — apply the instruction faithfully, even if it asks for something specific
(an example, a hard rule), while keeping everything else intact and the prompt coherent. The harness still
wins: an instruction to critique sequence messages goes to "unaddressed".`

const editSchema = z.object({
  prompt: z.string(),
  changelog: z.array(z.string()),
  unaddressed: z.array(z.string()),
})

export type EditorResult = z.infer<typeof editSchema>

const tag = (name: string, body: string, attrs = '') =>
  `<${name}${attrs ? ` ${attrs}` : ''}>\n${body}\n</${name}>`

/** One reviewed run as the editor sees it. */
export interface ReviewedCase {
  /** The thread as the coach read it for this run (the rendered, tagged text). */
  readonly conversation: string
  readonly promptVersion: number
  readonly output: {
    readonly next_action?: unknown
    readonly summary?: unknown
    readonly issues?: readonly { kind?: unknown; quote?: unknown; fix?: unknown }[]
    readonly ideas?: readonly { angle?: unknown; message?: unknown; why?: unknown }[]
  }
  readonly feedback: readonly {
    readonly target: 'take' | 'idea' | 'issue'
    readonly target_index: number | null
    readonly verdict: 'good' | 'bad' | null
    readonly comment: string | null
  }[]
}

export interface EarlierRound {
  readonly from: number | null
  readonly to: number
  readonly comments: readonly string[]
  readonly note: string | null
  readonly instruction: boolean
}

const CONVERSATION_CAP = 2500

function renderCase(c: ReviewedCase): string {
  const out = c.output
  const verdictOf = (target: 'idea' | 'issue', index: number) =>
    c.feedback.find((f) => f.target === target && f.target_index === index)
  const ideas = (out.ideas ?? []).map((idea, index) => {
    const f = verdictOf('idea', index)
    const attrs = [`n="${index + 1}"`, f?.verdict ? `marked="${f.verdict}"` : ''].filter(Boolean).join(' ')
    const body = `angle: ${String(idea.angle ?? '')}\nmessage: ${String(idea.message ?? '')}\nwhy: ${String(idea.why ?? '')}`
    return tag('idea', f?.comment ? `${body}\ncomment: ${f.comment}` : body, attrs)
  })
  const issues = (out.issues ?? []).map((issue, index) => {
    const f = verdictOf('issue', index)
    const attrs = [`n="${index + 1}"`, f?.verdict ? `marked="${f.verdict}"` : ''].filter(Boolean).join(' ')
    const body = `kind: ${String(issue.kind ?? '')}\nquote: ${String(issue.quote ?? '')}\nfix: ${String(issue.fix ?? '')}`
    return tag('feedback_item', f?.comment ? `${body}\ncomment: ${f.comment}` : body, attrs)
  })
  const take = c.feedback.find((f) => f.target === 'take')
  const parts = [
    tag('conversation', c.conversation.slice(-CONVERSATION_CAP)),
    tag('coach_output', [
      `next_action: ${String(out.next_action ?? '')}`,
      `summary: ${String(out.summary ?? '')}`,
      tag('ideas', ideas.join('\n') || '(none)'),
      tag('feedback_on_hand_written', issues.join('\n') || '(none)'),
    ].join('\n'), `prompt_version="${c.promptVersion}"`),
  ]
  if (take?.verdict || take?.comment) {
    parts.push(tag('comment_on_the_whole_take', [take.verdict ? `marked ${take.verdict}` : '', take.comment ?? ''].filter(Boolean).join('\n')))
  }
  return tag('reviewed_case', parts.join('\n'))
}

function renderRounds(rounds: readonly EarlierRound[]): string {
  return rounds.map((r) => {
    const lines = r.comments.map((c) => `- ${c}`)
    if (r.note) lines.push(r.instruction ? `- (instruction) ${r.note}` : `- (general) ${r.note}`)
    return `Round v${r.from ?? '?'}→v${r.to}:\n${lines.join('\n') || '- (marks only)'}`
  }).join('\n\n')
}

/** Everything the editor reads. Exported so a test can pin what it does and
 *  does not contain. */
export function editorInput(args: {
  currentPrompt: string
  cases?: readonly ReviewedCase[]
  general?: string
  instruction?: string
  earlier?: readonly EarlierRound[]
}): string {
  const parts = [tag('current_prompt', args.currentPrompt)]
  if (args.instruction) {
    parts.push(tag('team_instruction_about_the_prompt', args.instruction))
  } else {
    if (args.cases?.length) parts.push(tag('reviewed_cases', args.cases.map(renderCase).join('\n\n')))
    if (args.general?.trim()) parts.push(tag('general_feedback', args.general.trim()))
  }
  if (args.earlier?.length) parts.push(tag('earlier_feedback_already_addressed', renderRounds(args.earlier)))
  return parts.join('\n\n')
}

export async function runEditor(input: string, instruction: boolean): Promise<EditorResult> {
  const { object } = await generateObject({
    model: anthropic(EDITOR_MODEL),
    schema: editSchema,
    system: EDITOR_SYSTEM + (instruction ? DIRECT_INSTRUCTION_ADDENDUM : ''),
    prompt: input,
    maxOutputTokens: 32000,
    providerOptions: {
      anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
    },
  })
  return {
    prompt: object.prompt.trim(),
    changelog: object.changelog.map((x) => x.trim()).filter(Boolean),
    unaddressed: object.unaddressed.map((x) => x.trim()).filter(Boolean),
  }
}
