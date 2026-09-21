import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowDown, Check, ChevronDown, ChevronRight, Copy, Database, Loader2, Plus, RotateCw,
  Send, Sparkles, Square, X,
} from 'lucide-react'
import { authFetch } from '../lib/api'
import { Button, PageHeader } from '../ui'
import { COPY } from '../ui/labels'

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
      className={`inline-flex items-center gap-[5px] bg-none border-none px-1.5 py-0.5 cursor-pointer text-app-text-muted text-[length:var(--text-xs)] rounded-sm transition-[color,background] hover:text-app-text hover:bg-app-surface-2 ${className ?? ''}`}
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
    <div className="relative">
      <button type="button" className="inline-flex items-center gap-[5px] bg-none border-none px-1.5 py-0.5 cursor-pointer text-app-text-muted text-[length:var(--text-xs)] rounded-sm transition-[color,background] hover:text-app-text hover:bg-app-surface-2 absolute top-1.5 right-1.5 z-[1] !p-[3px] bg-app-surface-2 border border-app-border hover:bg-app-surface-3" onClick={copy} title={copied ? 'Copied' : 'Copy code'}>
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
      <button className="flex gap-app-sm items-center w-full bg-none border-none text-app-text px-app-md py-app-sm cursor-pointer text-[length:var(--text-sm)] text-left" onClick={() => setOpen(!open)}>
        <span className="chat-tool-icon inline-flex shrink-0 text-app-success">
          {running ? <Loader2 size={13} className="spin" /> : failed ? <X size={13} /> : <Check size={13} />}
        </span>
        <Database size={13} className="text-app-text-muted shrink-0" />
        <span className="font-semibold text-app-accent whitespace-nowrap">{name}</span>
        {part.input?.purpose && <span className="muted">{part.input.purpose}</span>}
        {rowCount != null && <span className="muted">{rowCount} rows</span>}
        {open ? <ChevronDown size={14} className="ml-auto text-app-text-muted shrink-0" /> : <ChevronRight size={14} className="ml-auto text-app-text-muted shrink-0" />}
      </button>
      {open && (
        <div className="border-t border-app-border px-app-md py-app-sm flex flex-col gap-app-sm [&_pre]:m-0 [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere] [&_pre]:max-h-[260px] [&_pre]:overflow-y-auto [&_pre]:text-app-text-secondary [&_pre]:text-[length:var(--text-xs)]">
          {sql && <pre>{sql}</pre>}
          {failed && <pre className="text-app-danger">{String(part.errorText ?? 'failed')}</pre>}
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
    <div className="border border-dashed border-app-border rounded-md bg-transparent text-[length:var(--text-sm)]">
      <button className="flex gap-app-sm items-center w-full bg-none border-none text-app-text px-app-md py-app-sm cursor-pointer text-[length:var(--text-sm)] text-left" onClick={() => setOpen(!open)}>
        <span className="text-app-text-muted font-semibold italic">Thinking</span>
        {open ? <ChevronDown size={14} className="ml-auto text-app-text-muted shrink-0" /> : <ChevronRight size={14} className="ml-auto text-app-text-muted shrink-0" />}
      </button>
      {open && <div className="border-t border-dashed border-app-border px-app-md py-app-sm text-app-text-muted whitespace-pre-wrap text-[length:var(--text-sm)] max-h-[220px] overflow-y-auto">{text}</div>}
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
      <div className="text-[length:var(--text-2xs)] font-semibold text-app-text-muted uppercase tracking-[var(--tracking-caps)]">{m.role === 'user' ? 'You' : 'Claude'}</div>
      <div className="flex flex-col gap-app-sm max-w-full">
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
          <div className="flex">
            <CopyButton text={assistantText} label  />
          </div>
        )}
      </div>
    </div>
  )
}

export function Chat() {
  const [initialMessages] = useState(loadStored)
  const [transport] = useState(() => new DefaultChatTransport({ fetch: authFetch }))
  const { messages, sendMessage, status, error, stop, regenerate, setMessages } = useChat({
    messages: initialMessages,
    transport,
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
      {/* No provider or query language in the user-facing copy: neither is
          something the reader can act on, and the name was wrong besides —
          production has not read Supabase since the cutover. The SQL Claude
          runs is still shown, per answer, in each tool block. */}
      <PageHeader
        title="Chat"
        description="Ask Claude about your campaign data. It reads the dashboard's own data and shows you the query behind each answer."
        actions={messages.length > 0 && (
          <Button variant="secondary" icon={<Plus size={18} aria-hidden="true" />} onClick={newChat}>
            New chat
          </Button>
        )}
      />

      <div className="card flex flex-col h-[calc(100vh-190px)] min-h-[420px] p-0 overflow-hidden relative">
        <div className="flex-1 overflow-y-auto p-[18px] flex flex-col gap-app-lg" ref={scrollRef} onScroll={onScroll}>
          {messages.length === 0 && (
            <div className="flex flex-col items-center text-center gap-2.5 m-auto max-w-[560px] py-app-sm px-0">
              <div className="inline-flex items-center justify-center w-[52px] h-[52px] rounded-lg bg-app-accent-subtle text-app-accent mb-0.5"><Sparkles size={26} /></div>
              <div className="text-[length:var(--text-lg)] font-semibold tracking-[-0.01em]">Ask about your campaign data</div>
              <div className="text-[length:var(--text-sm)] leading-[1.5] max-w-[460px] muted">
                Funnels, cohorts, per-account and per-step performance. Claude only
                reads — it never changes your data. Try one of these:
              </div>
              <div className="grid grid-cols-2 max-[560px]:grid-cols-1 gap-2.5 w-full mt-app-sm">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="bg-app-surface-2 border border-app-border text-app-text-secondary rounded-md px-[13px] py-[11px] text-[length:var(--text-sm)] leading-[1.4] text-left cursor-pointer transition-[border-color,color,background] hover:border-app-accent-border hover:text-app-text hover:bg-app-surface-3" onClick={() => submit(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} m={m} />
          ))}
          {status === 'submitted' && <div className="muted small pl-0.5">Thinking…</div>}
          {error && (
            <div className="banner text-app-danger" role="alert">
              <span>
                {looksLikeServerError(error)
                  ? 'Chat is not available right now. This is a server-side configuration problem, not something you can fix from here — the exact reason is in the details below.'
                  : `Request failed${error.message ? `: ${error.message}` : ''}.`}
              </span>
              {looksLikeServerError(error) && error.message && (
                <details className="basis-full [&>summary]:min-h-control-sm [&>summary]:text-app-text-secondary [&>summary]:text-app-meta [&>summary]:cursor-pointer [&_pre]:mt-app-sm [&_pre]:mx-0 [&_pre]:mb-0 [&_pre]:p-app-md [&_pre]:rounded-control [&_pre]:bg-[var(--code-bg)] [&_pre]:font-mono [&_pre]:text-app-meta [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]">
                  <summary>Details</summary>
                  <pre>{error.message}</pre>
                </details>
              )}
              <Button
                variant="secondary"
                size="sm"
                icon={<RotateCw size={16} aria-hidden="true" />}
                onClick={() => regenerate()}
                disabled={busy}
              >
                {COPY.retry}
              </Button>
            </div>
          )}
        </div>

        {showJump && (
          <button className="absolute left-1/2 -translate-x-1/2 bottom-[78px] z-[2] inline-flex items-center gap-1.5 px-app-md py-1.5 text-[length:var(--text-xs)] font-semibold text-app-text bg-app-surface-3 border border-app-border-strong rounded-full shadow-[var(--shadow-overlay)] cursor-pointer hover:border-app-accent-border hover:text-app-accent" type="button" onClick={jumpToLatest}>
            <ArrowDown size={14} />
            Jump to latest
          </button>
        )}

        <form
          className="flex gap-2.5 p-app-md border-t border-app-border items-end"
          onSubmit={(e) => {
            e.preventDefault()
            submit(input)
          }}
        >
          <textarea
            ref={inputRef}
            className="flex-1 bg-app-bg text-app-text border border-app-border rounded-md px-[14px] py-2.5 text-[length:var(--text-base)] font-[inherit] leading-[1.5] resize-none max-h-40 overflow-y-auto focus:border-app-accent focus:outline-none"
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
            <button className="chat-send stop inline-flex items-center justify-center shrink-0 w-10 h-10 text-app-on-accent border-none rounded-md cursor-pointer transition-[background,transform] disabled:opacity-50 disabled:cursor-default" type="button" onClick={() => stop()} title="Stop">
              <Square size={15} fill="currentColor" />
            </button>
          ) : (
            <button className="chat-send inline-flex items-center justify-center shrink-0 w-10 h-10 bg-app-accent text-app-on-accent border-none rounded-md cursor-pointer transition-[background,transform] enabled:hover:bg-app-accent-hover disabled:opacity-50 disabled:cursor-default" type="submit" disabled={!input.trim()} title="Send">
              <Send size={16} />
            </button>
          )}
        </form>
      </div>
    </>
  )
}
