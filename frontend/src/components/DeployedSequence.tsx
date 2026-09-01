import type { CampaignSequenceContext } from '../lib/types'

/** One entry of the compiled chain that was actually sent to Linked Helper. */
interface DeployedAction {
  kind: 'invite' | 'message' | 'wait' | 'automation'
  label: string
  detail: string | null
  body: TemplateNode[] | null
}

type TemplateNode = { type: 'text'; value: string } | { type: 'var'; name: string }

const AUTOMATION_LABEL: Record<string, string> = {
  VisitAndExtract: 'Visit profile and extract data',
  Follow: 'Follow the profile',
  FilterContactsOutOfMyNetwork: 'Wait for the invite to be accepted',
  CheckForReplies: 'Check for replies',
}

/** The exact action chain a publish job compiled for this deployment, rendered
 *  back into readable steps. This is the immutable snapshot Linked Helper was
 *  given — not a re-render of the sequence's current draft — so it stays true
 *  after the base sequence is edited. */
export function DeployedSequence({ context }: { context: CampaignSequenceContext }) {
  const actions = readActions(context.compiled_action_chain)

  if (actions.length === 0) {
    return (
      <div className="card">
        <h2>Deployed sequence</h2>
        <div className="muted small">
          {context.lineage === 'explicit_link'
            ? 'This campaign was linked to a sequence by hand, so there is no publish snapshot to show. The synced Linked Helper steps below are the record of what is running.'
            : 'No compiled action chain was stored for this deployment.'}
        </div>
      </div>
    )
  }

  return (
    <div className="card deployed-sequence">
      <div className="deployed-sequence-head">
        <h2>Deployed sequence</h2>
        <div className="muted small">
          Exactly what was published to Linked Helper
          {context.sequence_revision != null ? ` from revision ${context.sequence_revision}` : ''}
          {context.branch_letter ? ` · branch ${context.branch_letter}` : ''}.
        </div>
      </div>
      <ol className="deployed-sequence-list">
        {actions.map((action, index) => (
          <li key={index} className={`deployed-step deployed-step-${action.kind}`}>
            <div className="deployed-step-head">
              <span className="deployed-step-label">{action.label}</span>
              {action.detail && <span className="muted small">{action.detail}</span>}
            </div>
            {action.body && (
              <p className="deployed-step-body">
                {action.body.map((node, nodeIndex) => (node.type === 'text'
                  ? <span key={nodeIndex}>{node.value}</span>
                  : <span key={nodeIndex} className="deployed-step-var">{`{${node.name}}`}</span>))}
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

function readActions(chain: Array<Record<string, unknown>> | null): DeployedAction[] {
  if (!Array.isArray(chain)) return []
  const out: DeployedAction[] = []
  let messageIndex = 0
  for (const raw of chain) {
    const type = typeof raw?.type === 'string' ? raw.type : ''
    const settings = (raw?.settings ?? {}) as Record<string, unknown>
    if (type === 'InvitePerson') {
      out.push({
        kind: 'invite',
        label: 'Connection request',
        detail: null,
        body: templateNodes(settings.messageTemplate),
      })
    } else if (type === 'MessageToPerson') {
      messageIndex += 1
      out.push({
        kind: 'message',
        label: `Message ${messageIndex}`,
        detail: null,
        body: templateNodes(settings.messageTemplate),
      })
    } else if (type === 'Waiter') {
      const hours = typeof settings.delay === 'number' ? settings.delay : null
      out.push({
        kind: 'wait',
        label: 'Wait',
        detail: hours == null ? null : `${hours} ${hours === 1 ? 'hour' : 'hours'}`,
        body: null,
      })
    } else if (type) {
      out.push({
        kind: 'automation',
        label: AUTOMATION_LABEL[type] ?? type,
        detail: waitDetail(type, settings),
        body: null,
      })
    }
  }
  return out
}

/** `CheckForReplies` carries the delay before the next message as milliseconds. */
function waitDetail(type: string, settings: Record<string, unknown>): string | null {
  if (type !== 'CheckForReplies') return null
  const ms = settings.moveToSuccessfulAfterMs
  if (typeof ms !== 'number' || ms <= 0) return null
  const hours = Math.round(ms / 3_600_000)
  return `then wait ${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

/** Unwrap `{type:'variants', variants:[{child:{type:'group', children:[…]}}]}`,
 *  the shape the publish compiler writes for every template. */
function templateNodes(value: unknown): TemplateNode[] | null {
  const variants = (value as { variants?: unknown })?.variants
  const child = Array.isArray(variants)
    ? (variants[0] as { child?: unknown })?.child
    : value
  const children = (child as { children?: unknown })?.children
  if (!Array.isArray(children)) return null
  const nodes: TemplateNode[] = []
  for (const node of children) {
    if (node?.type === 'text' && typeof node.value === 'string') nodes.push({ type: 'text', value: node.value })
    else if (node?.type === 'var' && typeof node.name === 'string') nodes.push({ type: 'var', name: node.name })
  }
  return nodes.length ? nodes : null
}
