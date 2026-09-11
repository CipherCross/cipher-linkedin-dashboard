// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationThread } from '../src/components/conversation/ConversationThread'
import { ConversationActionPanel } from '../src/components/conversation/ConversationActionPanel'
import { ReplyReviewPanel } from '../src/components/conversation/ReplyReviewPanel'
import type { ReplyThreadMessage } from '../src/lib/replyReview'

const inbound: ReplyThreadMessage = { id: 1, instance_id: 'one', profile_url: 'https://linkedin.com/in/a', campaign_id: null, direction: 'in', body: 'Not now, perhaps next quarter.', sent_at: '2026-09-11T10:00:00.000Z', review: null }
const outbound: ReplyThreadMessage = { ...inbound, id: 2, direction: 'out', body: 'Hello there', sent_at: '2026-09-10T10:00:00.000Z' }

describe('Replies Inbox conversation UI', () => {
  afterEach(cleanup)
  it('renders bounded thread, allows selecting inbound and pagination', () => {
    const select = vi.fn(); const older = vi.fn()
    render(<ConversationThread messages={[outbound, inbound]} selectedMessageId={null} olderCursor="older" onSelectMessage={select} onLoadOlder={older} />)
    expect(screen.getByText('Not now, perhaps next quarter.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Входящее сообщение/ }))
    fireEvent.click(screen.getByRole('button', { name: /Загрузить старые/ }))
    expect(select).toHaveBeenCalledWith(inbound)
    expect(older).toHaveBeenCalled()
  })
  it('keeps negative validation visible and supports multi-reason checks', () => {
    const save = vi.fn()
    render(<ReplyReviewPanel message={inbound} review={null} onSave={save} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Негативный' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Нет бюджета/ }))
    fireEvent.click(screen.getByRole('button', { name: /Сохранить разметку/ }))
    expect(save).toHaveBeenCalled()
  })
  it('coordinates the DNC review reason through the draft callback', () => {
    const onDraftChange = vi.fn()
    render(<ReplyReviewPanel message={inbound} review={null} onSave={vi.fn()} onDraftChange={onDraftChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Не связываться/ }))
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ reason_ids: ['do_not_contact'] }))
    expect(screen.getByRole('status').textContent).toMatch(/атомарно вместе/)
  })
  it('includes DNC and its reason in one workflow draft', () => {
    const save = vi.fn()
    render(<ConversationActionPanel workflow={{ instance_id: 'one', profile_url: inbound.profile_url, action: null, owner_id: null, next_follow_up_date: null, do_not_contact: false, revision: 0, acknowledged_inbound_revision: 0 }} onSave={save} />)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByPlaceholderText(/контакт снова разрешил/), { target: { value: 'Explicit unsubscribe' } })
    fireEvent.click(screen.getByRole('button', { name: /Сохранить действие/ }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ action: 'resolved', do_not_contact: true, change_reason: 'Explicit unsubscribe' }))
  })
  it('allows setting DNC without a separate change comment', () => {
    const save = vi.fn()
    render(<ConversationActionPanel workflow={{ instance_id: 'one', profile_url: inbound.profile_url, action: 'needs_reply', owner_id: 2, next_follow_up_date: null, do_not_contact: false, revision: 0, acknowledged_inbound_revision: 0 }} onSave={save} />)
    fireEvent.click(screen.getByRole('checkbox'))
    const button = screen.getByRole('button', { name: /Сохранить действие/ })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ action: 'resolved', do_not_contact: true, change_reason: null }))
  })
  it('requires a comment and explicit next action when removing DNC', () => {
    const save = vi.fn()
    render(<ConversationActionPanel workflow={{ instance_id: 'one', profile_url: inbound.profile_url, action: 'resolved', owner_id: null, next_follow_up_date: null, do_not_contact: true, revision: 3, acknowledged_inbound_revision: 0 }} onSave={save} />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect((screen.getByRole('button', { name: /Сохранить действие/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: 'Статус диалога' }), { target: { value: 'resolved' } })
    fireEvent.change(screen.getByPlaceholderText(/снова разрешил/), { target: { value: 'Re-enabled contact' } })
    const button = screen.getByRole('button', { name: /Сохранить действие/ })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ action: 'resolved', do_not_contact: false, change_reason: 'Re-enabled contact' }))
  })
  it('blocks active actions while DNC is installed', () => {
    const save = vi.fn()
    render(<ConversationActionPanel workflow={{ instance_id: 'one', profile_url: inbound.profile_url, action: 'needs_reply', owner_id: 2, next_follow_up_date: null, do_not_contact: true, revision: 4, acknowledged_inbound_revision: 0 }} onSave={save} />)
    expect((screen.getByRole('combobox', { name: 'Статус диалога' }) as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Сохранить действие/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })
})
