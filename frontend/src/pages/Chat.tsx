import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useChat } from '@ai-sdk/react'
import type { UIMessage } from 'ai'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowDown, Check, ChevronDown, ChevronRight, Copy, Database, Loader2, Plus, RotateCw,
  Send, Sparkles, Square, X,
} from 'lucide-react'

const SUGGESTIONS = [
  'Why did the recent spike in invites not produce the same reply count as a month ago?',
  'Compare acceptance and reply rates by invite week for the last 8 weeks',
  'Which campaign and message step converts best right now?',
  'Are any accounts dragging down the overall reply rate?',
]

// Chat history is kept in sessionStorage so a stray navigation (open a campaign,
// hit back) doesn't wipe an investigation. Cleared explicitly via "New chat".
const STORAGE_KEY = 'chat:messages'

function loadStored(): UIMessage[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? (parsed as UIMessage[]) : []
  } catch {
    return []
  }
}

// A server 500 (bad/missing keys) is worth naming the env vars for; a plain
// network failure isn't — showing the key hint there just misleads.
function looksLikeServerError(err: Error): boolean {
  return /5\d\d|internal|api.?key|supabase|anthropic|service.?role/i.test(err.message || '')
}

interface SqlOutput {
  rows?: unknown[]
  rowCount?: number
  truncated?: boolean
}

function CopyButton({ text, label, className }: { text: string; label?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — nothing useful to show */
    }
  }
  return (
    <button
      type="button"
      className={`chat-copy ${className ?? ''}`}
      onClick={copy}
      title={copied ? 'Copied' : 'Copy'}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {label && <span>{copied ? 'Copied' : 'Copy'}</span>}
    </button>
  )
}

// Code fences get their own copy button; the pre text is read off the DOM at
// click time so we don't reconstruct the string from markdown AST nodes.
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref.current?.innerText ?? '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked */
    }
  }
  return (
    <div className="chat-code">
      <button type="button" className="chat-copy chat-code-copy" onClick={copy} title={copied ? 'Copied' : 'Copy code'}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
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
  const assistantText = m.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n\n')
    .trim()
  return (
    <div className={`chat-msg ${m.role}`}>
      <div className="chat-role">{m.role === 'user' ? 'You' : 'Claude'}</div>
      <div className="chat-body">
        {m.parts.map((part, i) => {
          if (part.type === 'text') {
            return (
              <div key={i} className="chat-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
                  {part.text}
                </ReactMarkdown>
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
        {m.role === 'assistant' && assistantText && (
          <div className="chat-msg-actions">
            <CopyButton text={assistantText} label className="chat-msg-copy" />
          </div>
        )}
      </div>
    </div>
  )
}

export function Chat() {
  const [initialMessages] = useState(loadStored)
  const { messages, sendMessage, status, error, stop, regenerate, setMessages } = useChat({
    messages: initialMessages,
  })
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Whether the view is stuck to the bottom; a ref so the streaming effect reads
  // the live value without re-subscribing on every scroll.
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const busy = status === 'submitted' || status === 'streaming'

  // Only auto-scroll while the user is pinned to the bottom — reading back
  // through a long answer shouldn't get yanked down on every streamed token.
  useEffect(() => {
    if (!pinnedRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    pinnedRef.current = atBottom
    setShowJump(!atBottom)
  }

  const jumpToLatest = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    pinnedRef.current = true
    setShowJump(false)
  }

  // Persist the transcript so navigation away and back doesn't lose it.
  useEffect(() => {
    try {
      if (messages.length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
      else sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      /* storage full / disabled — chat just won't persist */
    }
  }, [messages])

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
    pinnedRef.current = true
    setShowJump(false)
    sendMessage({ text: trimmed })
    setInput('')
  }

  const newChat = () => {
    if (busy) stop()
    setMessages([])
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
    setInput('')
    inputRef.current?.focus()
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
        {messages.length > 0 && (
          <div className="controls">
            <button className="btn sm" onClick={newChat}>
              <Plus size={15} />
              New chat
            </button>
          </div>
        )}
      </header>

      <div className="card chat-card">
        <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
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
            <div className="banner chat-error-banner" role="alert">
              <span>
                {looksLikeServerError(error)
                  ? `Chat error: ${error.message}. Check that ANTHROPIC_API_KEY and SUPABASE_SERVICE_ROLE_KEY are set on the deployment.`
                  : `Request failed${error.message ? `: ${error.message}` : ''}.`}
              </span>
              <button className="btn sm" onClick={() => regenerate()} disabled={busy}>
                <RotateCw size={13} />
                Retry
              </button>
            </div>
          )}
        </div>

        {showJump && (
          <button className="chat-jump" type="button" onClick={jumpToLatest}>
            <ArrowDown size={14} />
            Jump to latest
          </button>
        )}

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
