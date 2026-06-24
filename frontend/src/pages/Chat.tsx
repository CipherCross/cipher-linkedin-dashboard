import { useEffect, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import type { UIMessage } from 'ai'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const SUGGESTIONS = [
  'Why did the recent spike in invites not produce the same reply count as a month ago?',
  'Compare acceptance and reply rates by invite week for the last 8 weeks',
  'Which campaign and message step converts best right now?',
  'Are any accounts dragging down the overall reply rate?',
]

interface SqlOutput {
  rows?: unknown[]
  rowCount?: number
  truncated?: boolean
}

function ToolCall({ part }: { part: any }) {
  const [open, setOpen] = useState(false)
  const name: string = (part.type as string).replace(/^tool-/, '')
  const running = part.state === 'input-streaming' || part.state === 'input-available'
  const failed = part.state === 'output-error'
  const sql: string | undefined = part.input?.query
  const out = part.output as SqlOutput | string | undefined
  const rowCount = typeof out === 'object' && out ? out.rowCount : undefined

  return (
    <div className={`chat-tool ${failed ? 'failed' : ''}`}>
      <button className="chat-tool-head" onClick={() => setOpen(!open)}>
        <span className="chat-tool-name">
          {running ? '⏳' : failed ? '✕' : '✓'} {name}
        </span>
        {part.input?.purpose && <span className="muted">{part.input.purpose}</span>}
        {rowCount != null && <span className="muted">{rowCount} rows</span>}
        <span className="chat-tool-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="chat-tool-body">
          {sql && <pre>{sql}</pre>}
          {failed && <pre className="chat-error-text">{String(part.errorText ?? 'failed')}</pre>}
          {!failed && out != null && (
            <pre>
              {typeof out === 'string'
                ? out.slice(0, 4000)
                : JSON.stringify(out.rows ?? out, null, 2).slice(0, 4000)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <div className="chat-reasoning">
      <button className="chat-tool-head" onClick={() => setOpen(!open)}>
        <span className="chat-reasoning-label">Thinking</span>
        <span className="chat-tool-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="chat-reasoning-body">{text}</div>}
    </div>
  )
}

function Message({ m }: { m: UIMessage }) {
  return (
    <div className={`chat-msg ${m.role}`}>
      <div className="chat-role">{m.role === 'user' ? 'You' : 'Claude'}</div>
      <div className="chat-body">
        {m.parts.map((part, i) => {
          if (part.type === 'text') {
            return (
              <div key={i} className="chat-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
              </div>
            )
          }
          if (part.type === 'reasoning') {
            return <Reasoning key={i} text={part.text} />
          }
          if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
            return <ToolCall key={i} part={part} />
          }
          return null
        })}
      </div>
    </div>
  )
}

export function Chat() {
  const { messages, sendMessage, status, error } = useChat()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const busy = status === 'submitted' || status === 'streaming'

  // Pin to the newest message by scrolling the chat container itself; using
  // scrollIntoView here also scrolled the whole page, yanking it on every update.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status])

  const submit = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    sendMessage({ text: trimmed })
    setInput('')
  }

  return (
    <>
      <header>
        <div>
          <h1>Chat</h1>
          <div className="muted small">
            Ask Claude about your campaign data — it queries Supabase directly with
            read-only SQL.
          </div>
        </div>
      </header>

      <div className="card chat-card">
        <div className="chat-scroll" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="chat-empty">
              <div className="muted">Try one of these:</div>
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chat-suggestion" onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} m={m} />
          ))}
          {status === 'submitted' && <div className="muted small chat-thinking">Thinking…</div>}
          {error && (
            <div className="banner">
              Chat error: {error.message || 'request failed'}. Check that ANTHROPIC_API_KEY
              and SUPABASE_SERVICE_ROLE_KEY are set on the deployment.
            </div>
          )}
        </div>

        <form
          className="chat-input-row"
          onSubmit={(e) => {
            e.preventDefault()
            submit(input)
          }}
        >
          <input
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. Why are replies down despite more invites?"
            disabled={busy}
            autoFocus
          />
          <button className="chat-send" type="submit" disabled={busy || !input.trim()}>
            {busy ? '…' : 'Send'}
          </button>
        </form>
      </div>
    </>
  )
}
