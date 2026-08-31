import { describe, expect, it } from 'vitest'
import { createSequenceDocument } from '../src/lib/sequenceBuilder'
import {
  compileSequenceCampaigns,
  compileTemplate,
  normalizeVerifiedAccountSnapshot,
  SequencePublishValidationError,
  sha256Hex,
  type VerifiedAccountSnapshot,
} from '../src/lib/sequencePublish'

const account: VerifiedAccountSnapshot = {
  instanceId: 'uitop-1',
  machineKey: 'machine-a',
  accountId: 'account-1',
  accountName: 'Alyona',
  senderName: 'Alyona',
  workspaceId: 'workspace-1',
  lhVersion: 'fixture',
  compatibilityProfile: 'fixture-v1',
}

function document() {
  const value = createSequenceDocument()
  value.steps[0].variations[0].text = ''
  value.steps[1].variations[0].text = 'Hi {firstName} at {companyName}, {jobTitle}. From {senderName}'
  value.branches = [{
    id: 'branch_a',
    name: 'A',
    selections: Object.fromEntries(value.steps.map((step) => [step.id, step.variations[0].id])),
  }]
  return value
}

describe('Sequence publishing compiler', () => {
  it('normalizes snake_case agent snapshots and rejects conflicting aliases', () => {
    expect(normalizeVerifiedAccountSnapshot({
      account_id: 'account-1', account_name: 'Alyona', sender_name: 'Alyona',
      workspace_id: 'workspace-1', lh_version: 'fixture', compatibility_profile: 'fixture-v1',
    }, { instanceId: 'uitop-1', machineKey: 'machine-a' })).toEqual(account)
    expect(normalizeVerifiedAccountSnapshot({
      accountId: 'account-1', account_id: 'account-2', accountName: 'Alyona',
      senderName: 'Alyona', workspaceId: 'workspace-1', lhVersion: 'fixture',
      compatibilityProfile: 'fixture-v1',
    }, { instanceId: 'uitop-1', machineKey: 'machine-a' })).toBeNull()
  })

  it('matches the fixture action contract and keeps an empty invite AST valid', () => {
    const campaign = compileSequenceCampaigns('Founder outreach', document(), {
      branchIds: ['branch_a'],
      visit: true,
      follow: true,
      preInviteDelayHours: 24,
      inviteToFirstMessageDelayHours: 24,
      interMessageDelayHours: [],
    }, account)[0]
    expect(campaign.campaignName).toBe('Founder outreach A')
    expect(campaign.actions.map((item) => item.type)).toEqual([
      'VisitAndExtract', 'Follow', 'Waiter', 'InvitePerson',
      'FilterContactsOutOfMyNetwork', 'Waiter', 'MessageToPerson', 'CheckForReplies',
    ])
    expect(campaign.actions[3]).toMatchObject({
      settings: { messageTemplate: { variants: [{ child: { children: [] } }] } },
      coolDown: 60_000,
      maxActionResultsPerIteration: 10,
    })
    expect(campaign.actions.at(-1)).toMatchObject({
      settings: {
        moveToSuccessfulAfterMs: null,
        treatMessageAcceptedAsReply: false,
        keepInQueueIfRequestIsNotAccepted: true,
      },
      coolDown: 3_600_000,
      maxActionResultsPerIteration: -1,
    })
  })

  it('keeps document-order branch letters when only A and C are selected', () => {
    const value = document()
    value.branches.push(
      { ...value.branches[0], id: 'branch_b', name: 'B' },
      { ...value.branches[0], id: 'branch_c', name: 'C' },
    )
    const campaigns = compileSequenceCampaigns('Sequence', value, {
      branchIds: ['branch_a', 'branch_c'], visit: false, follow: false,
      inviteToFirstMessageDelayHours: 24, interMessageDelayHours: [],
    }, account)
    expect(campaigns.map((item) => item.campaignName)).toEqual(['Sequence A', 'Sequence C'])
  })

  it('encodes inter-message delay in the preceding reply check', () => {
    const value = document()
    value.steps.push({ id: 'step_3', kind: 'message', variations: [{ id: 'variation_3', label: 'V1', text: 'Second' }] })
    value.branches[0].selections.step_3 = 'variation_3'
    const campaign = compileSequenceCampaigns('Sequence', value, {
      branchIds: ['branch_a'], visit: false, follow: false,
      inviteToFirstMessageDelayHours: 24, interMessageDelayHours: [48],
    }, account)[0]
    expect(campaign.actions.map((item) => item.type)).toEqual([
      'InvitePerson', 'FilterContactsOutOfMyNetwork', 'Waiter',
      'MessageToPerson', 'CheckForReplies', 'MessageToPerson', 'CheckForReplies',
    ])
    expect(campaign.actions[4].settings.moveToSuccessfulAfterMs).toBe(172_800_000)
  })

  it('parses native variable nodes and resolves sender name as static text', () => {
    expect(compileTemplate('Hi {firstName} at {companyName}, {jobTitle} — {senderName}', 'Sam')).toEqual({
      type: 'group',
      children: [
        { type: 'text', value: 'Hi ' }, { type: 'var', name: 'firstName' },
        { type: 'text', value: ' at ' }, { type: 'var', name: 'company' },
        { type: 'text', value: ', ' }, { type: 'var', name: 'position' },
        { type: 'text', value: ' — ' }, { type: 'text', value: 'Sam' },
      ],
    })
  })

  it('rejects unknown tokens, empty messages, and invalid delays', () => {
    expect(() => compileTemplate('{unknown}', 'Sam')).toThrow(SequencePublishValidationError)
    const value = document()
    value.steps[1].variations[0].text = '   '
    expect(() => compileSequenceCampaigns('Sequence', value, {
      branchIds: ['branch_a'], visit: false, follow: false,
      inviteToFirstMessageDelayHours: 0, interMessageDelayHours: [],
    }, account)).toThrow(SequencePublishValidationError)
  })

  it('uses a standards-compatible deterministic sha256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
