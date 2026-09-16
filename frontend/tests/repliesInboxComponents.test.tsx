// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationThread } from '../src/components/conversation/ConversationThread'
import { ConversationActionPanel } from '../src/components/conversation/ConversationActionPanel'
import { ReplyReviewPanel } from '../src/components/conversation/ReplyReviewPanel'
import type { ReplyThreadMessage, ReplyWorkflow } from '../src/lib/replyReview'
import { validateReplyWorkflowInput } from '../api/_lib/replyReview'

const inbound: ReplyThreadMessage = { id: 1, instance_id: 'one', profile_url: 'https://linkedin.com/in/a', campaign_id: null, direction: 'in', body: 'Not now, perhaps next quarter.', sent_at: '2026-09-11T10:00:00.000Z', review: null }
const outbound: ReplyThreadMessage = { ...inbound, id: 2, direction: 'out', body: 'Hello there', sent_at: '2026-09-10T10:00:00.000Z' }
const followUpWorkflow: ReplyWorkflow = { instance_id: 'one', profile_url: inbound.profile_url, action: 'follow_up', owner_id: 2, next_follow_up_date: '2099-12-31', do_not_contact: false, revision: 4, acknowledged_inbound_revision: 1 }
const members = [{ id: 2, name: 'Anastasia', active: true }, { id: 3, name: 'David', active: true }]

describe('Replies Inbox conversation UI', () => {
  afterEach(cleanup)
  it('renders bounded thread, allows selecting inbound and pagination', () => {
    const select = vi.fn(); const older = vi.fn()
    render(<ConversationThread messages={[outbound, inbound]} selectedMessageId={null} olderCursor="older" onSelectMessage={select} onLoadOlder={older} />)
    expect(screen.getByText('Not now, perhaps next quarter.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Inbound message/ }))
    fireEvent.click(screen.getByRole('button', { name: /Load older messages/ }))
    expect(select).toHaveBeenCalledWith(inbound)
    expect(older).toHaveBeenCalled()
  })
  it('keeps negative validation visible and supports multi-reason checks', () => {
    const save = vi.fn()
    render(<ReplyReviewPanel message={inbound} review={null} onSave={save} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Negative' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /No budget or too expensive/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(save).toHaveBeenCalled()
  })
  it('coordinates the DNC review reason through the draft callback', () => {
    const onDraftChange = vi.fn()
    render(<ReplyReviewPanel message={inbound} review={null} onSave={vi.fn()} onDraftChange={onDraftChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Add a reason/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Do not contact \/ unsubscribe/ }))
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ reason_ids: ['do_not_contact'] }))
    expect(screen.getByRole('status').textContent).toMatch(/Stop the Linked Helper campaign separately/)
  })
  it('includes DNC and its reason in one workflow draft', () => {
    const save = vi.fn()
    render(<ConversationActionPanel workflow={{ instance_id: 'one', profile_url: inbound.profile_url, action: null, owner_id: null, next_follow_up_date: null, do_not_contact: false, revision: 0, acknowledged_inbound_revision: 0 }} onSave={save} />)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /Add a comment/ }))
    fireEvent.change(screen.getByPlaceholderText(/agreed to be contacted again/), { target: { value: 'Explicit unsubscribe' } })
    fireEvent.click(screen.getByRole('button', { name: /Save next step/ }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ action: 'resolved', do_not_contact: true, change_reason: 'Explicit unsubscribe' }))
  })
  it('allows setting DNC without a separate change comment', () => {
    const save = vi.fn()
    render(<ConversationActionPanel workflow={{ instance_id: 'one', profile_url: inbound.profile_url, action: 'needs_reply', owner_id: 2, next_follow_up_date: null, do_not_contact: false, revision: 0, acknowledged_inbound_revision: 0 }} onSave={save} />)
    fireEvent.click(screen.getByRole('checkbox'))
    const button = screen.getByRole('button', { name: /Save next step/ })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ action: 'resolved', do_not_contact: true, change_reason: null }))
  })
  it('requires a comment and explicit next action when removing DNC', () => {
    const save = vi.fn()
    render(<ConversationActionPanel workflow={{ instance_id: 'one', profile_url: inbound.profile_url, action: 'resolved', owner_id: null, next_follow_up_date: null, do_not_contact: true, revision: 3, acknowledged_inbound_revision: 0 }} onSave={save} />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect((screen.getByRole('button', { name: /Save next step/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: 'Conversation status' }), { target: { value: 'resolved' } })
    fireEvent.change(screen.getByPlaceholderText(/agreed to be contacted again/), { target: { value: 'Re-enabled contact' } })
    const button = screen.getByRole('button', { name: /Save next step/ })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ action: 'resolved', do_not_contact: false, change_reason: 'Re-enabled contact' }))
  })
  it('blocks active actions while DNC is installed', () => {
    const save = vi.fn()
    render(<ConversationActionPanel workflow={{ instance_id: 'one', profile_url: inbound.profile_url, action: 'needs_reply', owner_id: 2, next_follow_up_date: null, do_not_contact: true, revision: 4, acknowledged_inbound_revision: 0 }} onSave={save} />)
    expect((screen.getByRole('combobox', { name: 'Conversation status' }) as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Save next step/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })
  it.each(['needs_reply', 'awaiting_reply', 'resolved', 'closed_soft', 'closed_hard', null] as const)('clears the follow-up date from combined-save drafts when switching to %s', (action) => {
    const onDraftChange = vi.fn()
    render(<ConversationActionPanel workflow={followUpWorkflow} members={members} inboundRevision={2} externalActions onSave={vi.fn()} onDraftChange={onDraftChange} />)

    fireEvent.change(screen.getByRole('combobox', { name: 'Conversation status' }), { target: { value: action ?? '' } })
    expect(screen.queryByLabelText('Follow-up date')).toBeNull()
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ action, next_follow_up_date: null, expected_revision: 4, observed_inbound_revision: 2 }))

    // Later owner/comment edits must not resurrect the hidden date.
    fireEvent.change(screen.getByRole('combobox', { name: 'Conversation owner' }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Add a comment/ }))
    fireEvent.change(screen.getByPlaceholderText(/agreed to be contacted again/), { target: { value: 'Updated next step' } })
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ action, owner_id: 3, next_follow_up_date: null, change_reason: 'Updated next step' }))
    expect(() => validateReplyWorkflowInput(onDraftChange.mock.lastCall![0])).not.toThrow()

    fireEvent.change(screen.getByRole('combobox', { name: 'Conversation status' }), { target: { value: 'follow_up' } })
    expect((screen.getByLabelText('Follow-up date') as HTMLInputElement).value).toBe('')
    expect(screen.getByText(/Choose a follow-up date no earlier than today/)).toBeTruthy()
  })
  it('cancels the date when DNC is enabled in a combined-save draft', () => {
    const onDraftChange = vi.fn()
    render(<ConversationActionPanel workflow={followUpWorkflow} members={members} externalActions onSave={vi.fn()} onDraftChange={onDraftChange} />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'resolved', do_not_contact: true, next_follow_up_date: null }))
    expect(() => validateReplyWorkflowInput(onDraftChange.mock.lastCall![0])).not.toThrow()
  })
  it('shows date validation only when a required date is missing or past', () => {
    const save = vi.fn()
    const onValidityChange = vi.fn()
    render(<ConversationActionPanel workflow={followUpWorkflow} members={members} onSave={save} onValidityChange={onValidityChange} />)
    expect(screen.queryByText(/Choose a follow-up date/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Save next step/ }))
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'follow_up', next_follow_up_date: '2099-12-31' }))

    fireEvent.change(screen.getByLabelText('Follow-up date'), { target: { value: '2000-01-01' } })
    expect(screen.getByText(/Choose a follow-up date/)).toBeTruthy()
    expect(onValidityChange).toHaveBeenLastCalledWith(false)
    expect((screen.getByRole('button', { name: /Save next step/ }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByRole('combobox', { name: 'Conversation status' }), { target: { value: 'awaiting_reply' } })
    expect(screen.queryByText(/Choose a follow-up date/)).toBeNull()
    expect(onValidityChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: /Save next step/ }))
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'awaiting_reply', next_follow_up_date: null }))
  })
})
