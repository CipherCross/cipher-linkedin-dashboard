// @vitest-environment jsdom
/**
 * Chat after its Phase 10 conversion to the canonical `src/ui` contracts:
 * disclosure toggles and the composer's Send/Stop are `Button`/`IconButton`,
 * the composer textarea is the shared `Textarea`, and both the message-level
 * and code-block copy actions go through the one shared `CopyButton`
 * (`src/components/CopyButton.tsx`) instead of two private implementations.
 *
 * `useChat` is mocked so every case controls `messages`/`status`/`error`
 * directly and asserts on `sendMessage`/`stop`/`regenerate` — this pins
 * streaming/retry/stop/suggestion/composer behaviour without a real network
 * or SSE stream.
 *
 * jsdom does not implement `innerText` (it reads back `undefined`), which the
 * code-block copy depends on to read the rendered `<pre>` at click time. The
 * polyfill below (textContent-backed) is scoped to this file so that case
 * exercises the real click-time read instead of trivially copying `''`.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'

const chat = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  status: 'ready' as string,
  error: undefined as Error | undefined,
  sendMessage: vi.fn(),
  stop: vi.fn(),
  regenerate: vi.fn(),
  setMessages: vi.fn(),
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    sendMessage: chat.sendMessage,
    stop: chat.stop,
    regenerate: chat.regenerate,
    setMessages: chat.setMessages,
  }),
}))

import { Chat } from '../src/pages/Chat'

const textPart = (text: string) => ({ type: 'text' as const, text })

beforeAll(() => {
  // jsdom has no layout engine, so it never implemented `innerText`. The
  // component reads it off a real `<pre>` at click time (not the markdown AST),
  // so without this the code-block case would pass by copying '' either way.
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return this.textContent ?? '' },
  })
})

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  chat.messages = []
  chat.status = 'ready'
  chat.error = undefined
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } })
  try { sessionStorage.clear() } catch { /* ignore */ }
})

const SUGGESTIONS = [
  'Why did the recent spike in invites not produce the same reply count as a month ago?',
  'Compare acceptance and reply rates by invite week for the last 8 weeks',
  'Which campaign and message step converts best right now?',
  'Are any accounts dragging down the overall reply rate?',
]

describe('the empty state', () => {
  it('shows the four suggestions and sends the clicked one', () => {
    render(<Chat />)
    for (const s of SUGGESTIONS) expect(screen.getByText(s)).toBeTruthy()

    fireEvent.click(screen.getByText(SUGGESTIONS[2]))
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: SUGGESTIONS[2] })
  })
})

describe('the composer', () => {
  it('sends on Enter and clears the box; Shift+Enter does not send', () => {
    render(<Chat />)
    const box = screen.getByRole('textbox', { name: 'Message Claude' })

    fireEvent.change(box, { target: { value: 'How are invites trending?' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(chat.sendMessage).not.toHaveBeenCalled()
    expect((box as HTMLTextAreaElement).value).toBe('How are invites trending?')

    fireEvent.keyDown(box, { key: 'Enter' })
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'How are invites trending?' })
    expect((box as HTMLTextAreaElement).value).toBe('')
  })

  it('shows Stop generating (and no Send) while streaming, and it calls stop', () => {
    chat.status = 'streaming'
    render(<Chat />)
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    const stopBtn = screen.getByRole('button', { name: 'Stop generating' })

    fireEvent.click(stopBtn)
    expect(chat.stop).toHaveBeenCalled()
  })

  it('shows Send (and no Stop) once idle, disabled until there is input', () => {
    render(<Chat />)
    expect(screen.queryByRole('button', { name: 'Stop generating' })).toBeNull()
    const sendBtn = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)

    fireEvent.change(screen.getByRole('textbox', { name: 'Message Claude' }), { target: { value: 'hi' } })
    expect(sendBtn.disabled).toBe(false)
  })
})

describe('copy actions', () => {
  it('copies an assistant message and flips the visible word to Copied', async () => {
    chat.messages = [
      { id: 'm1', role: 'assistant', parts: [textPart('The reply rate is 12%.')] } as UIMessage,
    ]
    render(<Chat />)
    const copyBtn = screen.getByRole('button', { name: 'Copy' })

    await act(async () => { fireEvent.click(copyBtn) })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('The reply rate is 12%.')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it("copies a code block's own rendered text", async () => {
    chat.messages = [
      { id: 'm2', role: 'assistant', parts: [textPart('```\nSELECT 1;\n```')] } as UIMessage,
    ]
    render(<Chat />)
    const copyCode = screen.getByRole('button', { name: 'Copy code' })

    await act(async () => { fireEvent.click(copyCode) })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('SELECT 1;'))
  })
})

describe('a tool call', () => {
  it('toggles aria-expanded and reveals the SQL', () => {
    chat.messages = [
      {
        id: 'm3',
        role: 'assistant',
        parts: [{
          type: 'tool-run_sql',
          state: 'output-available',
          input: { query: 'SELECT count(*) FROM leads' },
          output: { rows: [], rowCount: 3 },
        }],
      } as unknown as UIMessage,
    ]
    render(<Chat />)
    const toggle = screen.getByRole('button', { name: /run_sql/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('SELECT count(*) FROM leads')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('SELECT count(*) FROM leads')).toBeTruthy()
  })
})

describe('a request error', () => {
  it('shows role=alert with a Retry that calls regenerate', () => {
    chat.error = new Error('boom')
    render(<Chat />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/Request failed: boom/)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(chat.regenerate).toHaveBeenCalled()
  })
})
