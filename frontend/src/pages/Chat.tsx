import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowDown, Check, ChevronDown, ChevronRight, Database, Loader2, Plus,
  Send, Sparkles, Square, X,
} from 'lucide-react'
import { authFetch } from '../lib/api'
import { Button, IconButton, InlineError, PageHeader, Panel, Textarea } from '../ui'
import { COPY } from '../ui/labels'
import { CopyButton } from '../components/CopyButton'

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

// Code fences get their own copy button; the pre text is read off the DOM at
// click time so we don't reconstruct the string from markdown AST nodes —
// CopyButton's thunk form defers that read until the click happens.
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div className="relative">
      <CopyButton
        text={() => ref.current?.innerText ?? ''}
        title="Copy code"
        className="absolute top-1.5 right-1.5 z-[1] bg-app-surface-2 border border-app-border hover:bg-app-surface-3"
      />
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

function ToolCall({ part }: { part: any }) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const name: string = (part.type as string).replace(/^tool-/, '')
  const running = part.state === 'input-streaming' || part.state === 'input-available'
  const failed = part.state === 'output-error'
  const sql: string | undefined = part.input?.query
  const out = part.output as SqlOutput | string | undefined
  const rowCount = typeof out === 'object' && out ? out.rowCount : undefined

  const edgeColor = failed ? 'border-l-app-danger' : running ? 'border-l-app-warning' : 'border-l-app-accent-border'
  const iconColor = failed ? 'text-app-danger' : running ? 'text-app-warning' : 'text-app-success'

  return (
    <div className={`border border-app-border border-l-2 ${edgeColor} rounded-md bg-app-surface-2 text-[length:var(--text-sm)]`}>
      <Button
        variant="ghost"
        block
        className="justify-start gap-app-sm text-app-text px-app-md py-app-sm text-[length:var(--text-sm)] font-normal rounded-none"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(!open)}
      >
        <span className={`inline-flex shrink-0 ${iconColor}`}>
          {running ? <Loader2 size={13} className="animate-spin" /> : failed ? <X size={13} /> : <Check size={13} />}
        </span>
        <Database size={13} className="text-app-text-muted shrink-0" />
        <span className="font-semibold text-app-accent whitespace-nowrap">{name}</span>
        {part.input?.purpose && <span className="text-app-text-muted">{part.input.purpose}</span>}
        {rowCount != null && <span className="text-app-text-muted">{rowCount} rows</span>}
        {open ? <ChevronDown size={14} className="ml-auto text-app-text-muted shrink-0" /> : <ChevronRight size={14} className="ml-auto text-app-text-muted shrink-0" />}
      </Button>
      {open && (
        <div id={contentId} className="border-t border-app-border px-app-md py-app-sm flex flex-col gap-app-sm [&_pre]:m-0 [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere] [&_pre]:max-h-[260px] [&_pre]:overflow-y-auto [&_pre]:text-app-text-secondary [&_pre]:text-[length:var(--text-xs)]">
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
  const contentId = useId()
  if (!text.trim()) return null
  return (
    <div className="border border-dashed border-app-border rounded-md bg-transparent text-[length:var(--text-sm)]">
      <Button
        variant="ghost"
        block
        className="justify-start gap-app-sm text-app-text px-app-md py-app-sm text-[length:var(--text-sm)] font-normal rounded-none"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(!open)}
      >
        <span className="text-app-text-muted font-semibold italic">Thinking</span>
        {open ? <ChevronDown size={14} className="ml-auto text-app-text-muted shrink-0" /> : <ChevronRight size={14} className="ml-auto text-app-text-muted shrink-0" />}
      </Button>
      {open && <div id={contentId} className="border-t border-dashed border-app-border px-app-md py-app-sm text-app-text-muted whitespace-pre-wrap text-[length:var(--text-sm)] max-h-[220px] overflow-y-auto">{text}</div>}
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
            <CopyButton text={assistantText} showLabel />
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

      <Panel className="flex flex-col h-[calc(100vh-190px)] min-h-[420px] p-0 overflow-hidden relative">
        <div className="flex-1 overflow-y-auto p-[18px] flex flex-col gap-app-lg" ref={scrollRef} onScroll={onScroll}>
          {messages.length === 0 && (
            <div className="flex flex-col items-center text-center gap-2.5 m-auto max-w-[560px] py-app-sm px-0">
              <div className="inline-flex items-center justify-center w-[52px] h-[52px] rounded-lg bg-app-accent-subtle text-app-accent mb-0.5"><Sparkles size={26} /></div>
              <div className="text-[length:var(--text-lg)] font-semibold tracking-[-0.01em]">Ask about your campaign data</div>
              <div className="text-[length:var(--text-sm)] leading-[1.5] max-w-[460px] text-app-text-muted">
                Funnels, cohorts, per-account and per-step performance. Claude only
                reads — it never changes your data. Try one of these:
              </div>
              <div className="grid grid-cols-2 max-[560px]:grid-cols-1 gap-2.5 w-full mt-app-sm">
                {SUGGESTIONS.map((s) => (
                  <Button
                    key={s}
                    variant="secondary"
                    className="h-auto justify-start whitespace-normal text-left font-normal bg-app-surface-2 border-app-border text-app-text-secondary px-[13px] py-[11px] text-[length:var(--text-sm)] leading-[1.4] hover:border-app-accent-border hover:text-app-text hover:bg-app-surface-3"
                    onClick={() => submit(s)}
                  >
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} m={m} />
          ))}
          {status === 'submitted' && <div className="text-app-text-muted text-app-meta pl-0.5">Thinking…</div>}
          {error && (
            <InlineError
              title={looksLikeServerError(error)
                ? 'Chat is not available right now. This is a server-side configuration problem, not something you can fix from here — the exact reason is in the details below.'
                : `Request failed${error.message ? `: ${error.message}` : ''}.`}
              detail={looksLikeServerError(error) ? error.message : undefined}
              onRetry={() => regenerate()}
              retryLabel={COPY.retry}
              busy={busy}
            />
          )}
        </div>

        {showJump && (
          <Button
            variant="secondary"
            size="sm"
            icon={<ArrowDown size={14} aria-hidden="true" />}
            className="absolute left-1/2 -translate-x-1/2 bottom-[78px] z-[2] rounded-full bg-app-surface-3 border-app-border-strong shadow-[var(--shadow-overlay)] hover:border-app-accent-border hover:text-app-accent"
            onClick={jumpToLatest}
          >
            Jump to latest
          </Button>
        )}

        <form
          className="flex gap-2.5 p-app-md border-t border-app-border items-end"
          onSubmit={(e) => {
            e.preventDefault()
            submit(input)
          }}
        >
          <Textarea
            ref={inputRef}
            className="flex-1 min-h-control resize-none max-h-40 overflow-y-auto"
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
            aria-label="Message Claude"
            autoFocus
          />
          {busy ? (
            <IconButton
              label="Stop generating"
              icon={<Square size={15} fill="currentColor" aria-hidden="true" />}
              className="bg-app-danger text-app-on-accent hover:opacity-90"
              onClick={() => stop()}
            />
          ) : (
            <IconButton
              type="submit"
              label="Send"
              icon={<Send size={16} aria-hidden="true" />}
              className="bg-app-accent text-app-on-accent hover:bg-app-accent-hover"
              disabled={!input.trim()}
            />
          )}
        </form>
      </Panel>
    </>
  )
}
