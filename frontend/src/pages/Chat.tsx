import { useEffect, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import type { UIMessage } from 'ai'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check, ChevronDown, ChevronRight, Database, Loader2, Send, Sparkles, Square, X,
} from 'lucide-react'

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
    <div className={`chat-tool ${failed ? 'failed' : running ? 'running' : ''}`}>
      <button className="chat-tool-head" onClick={() => setOpen(!open)}>
        <span className="chat-tool-icon">
          {running ? <Loader2 size={13} className="spin" /> : failed ? <X size={13} /> : <Check size={13} />}
        </span>
        <Database size={13} className="chat-tool-glyph" />
        <span className="chat-tool-name">{name}</span>
        {part.input?.purpose && <span className="muted">{part.input.purpose}</span>}
        {rowCount != null && <span className="muted">{rowCount} rows</span>}
        {open ? <ChevronDown size={14} className="chat-tool-caret" /> : <ChevronRight size={14} className="chat-tool-caret" />}
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
        {open ? <ChevronDown size={14} className="chat-tool-caret" /> : <ChevronRight size={14} className="chat-tool-caret" />}
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
  const { messages, sendMessage, status, error, stop } = useChat()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const busy = status === 'submitted' || status === 'streaming'

  // Pin to the newest message by scrolling the chat container itself; using
  // scrollIntoView here also scrolled the whole page, yanking it on every update.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status])

  // Grow the textarea with its content up to a cap, then scroll internally.
  const grow = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }
  useEffect(grow, [input])

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
              <div className="chat-empty-icon"><Sparkles size={26} /></div>
              <div className="chat-empty-title">Ask about your campaign data</div>
              <div className="chat-empty-blurb muted">
                Claude answers with read-only SQL against Supabase — funnels, cohorts,
                per-account and per-step performance. Try one of these:
              </div>
              <div className="chat-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chat-suggestion" onClick={() => submit(s)}>
                    {s}
                  </button>
                ))}
              </div>
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
          <textarea
            ref={inputRef}
            className="chat-input"
            value={input}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit(input)
              }
            }}
            placeholder="Ask anything — Enter to send, Shift+Enter for a new line"
            autoFocus
          />
          {busy ? (
            <button className="chat-send stop" type="button" onClick={() => stop()} title="Stop">
              <Square size={15} fill="currentColor" />
            </button>
          ) : (
            <button className="chat-send" type="submit" disabled={!input.trim()} title="Send">
              <Send size={16} />
            </button>
          )}
        </form>
      </div>
    </>
  )
}
