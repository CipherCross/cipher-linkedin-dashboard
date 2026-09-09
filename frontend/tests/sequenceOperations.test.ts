import { describe, expect, it } from 'vitest'
import { buildApplicationRegistry } from '../api/_lib/data/operations/index.js'
import {
  SEQUENCE_COMMANDS,
  SEQUENCE_OPERATIONS,
  createSequenceOperation,
  saveSequenceOperation,
  sequenceCommentsOperation,
} from '../api/_lib/data/operations/sequences.js'
import { claimSequencePublishCanaryOperation, reportSequencePublishTargetOperation, setSequencePublishBranchResultOperation } from '../api/_lib/data/operations/sequencePublishing.js'
import type { UserActorContext } from '../api/_lib/data/contracts.js'

const actor: UserActorContext = {
  kind: 'user',
  actorId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-test',
  role: 'member',
}

describe('Sequence Builder operation allowlist', () => {
  it('registers every read and write under fixed semantic names', () => {
    const registry = buildApplicationRegistry()
    for (const operation of Object.values(SEQUENCE_OPERATIONS)) {
      expect(registry.lookupQuery(operation)).toBeDefined()
    }
    for (const operation of Object.values(SEQUENCE_COMMANDS)) {
      expect(registry.lookupCommand(operation)).toBeDefined()
    }
  })

  it('parameterizes document JSON and actor identity on create', () => {
    const statement = createSequenceOperation.build({
      actor,
      params: {
        name: 'Founder outreach',
        documentJson: '{"version":1}',
        actorName: 'Alex',
      },
    })
    expect(statement.text).toContain('INSERT INTO public.sequence_documents')
    expect(statement.text).not.toContain('Founder outreach')
    expect(statement.values).toEqual([
      'Founder outreach',
      '{"version":1}',
      actor.actorId,
      'Alex',
    ])
  })

  it('makes autosave revision compare-and-swap explicit in SQL', () => {
    const statement = saveSequenceOperation.build({
      actor,
      params: {
        sequenceId: '22222222-2222-4222-8222-222222222222',
        expectedRevision: 7,
        name: 'Founder outreach',
        documentJson: '{"version":1}',
        actorName: 'Alex',
      },
    })
    expect(statement.text).toContain('d.revision = $2::integer')
    expect(statement.text).toContain('revision = d.revision + 1')
    expect(statement.values?.[1]).toBe(7)
  })

  it('loads threaded comments in deterministic message order', () => {
    const statement = sequenceCommentsOperation.build({
      actor,
      params: { sequenceId: '22222222-2222-4222-8222-222222222222' },
      page: { limit: 100, cursor: null },
      range: undefined,
      after: undefined,
    })
    expect(statement.text).toContain('JOIN public.sequence_comment_messages')
    expect(statement.text).toContain('ORDER BY t.created_at, t.id, m.created_at, m.id')
  })

  it('qualifies branch timestamps when journaling through the job join', () => {
    const statement = setSequencePublishBranchResultOperation.build({
      actor,
      params: {
        jobId: '22222222-2222-4222-8222-222222222222',
        branchId: 'branch_a',
        generation: 1,
        status: 'publishing',
        campaignId: '',
        verificationJson: '',
        errorCode: '',
        errorJson: '',
      },
    })
    expect(statement.text).toContain('COALESCE(b.started_at, now())')
  })

  it('atomically deduplicates contract canaries and replacement lineage', () => {
    const report = reportSequencePublishTargetOperation.build({ actor, params: {
      instanceId: 'notebook-1', machineKey: 'machine', accountJson: '{}', capabilityJson: '{}',
      compatible: true, errorCode: '', credentialId: actor.actorId,
      measuredLhVersion: '2.130.35', contractFingerprint: 'a'.repeat(64), contractEvidenceJson: '{}',
    } })
    expect(report.text).toContain('ON CONFLICT (contract_fingerprint) DO NOTHING')
    expect(report.text).toContain("j.error_code IN ('LH_VERSION_MISMATCH','PUBLISH_CONTRACT_MISMATCH')")
    expect(report.text).toContain('ON CONFLICT (replaces_job_id) DO NOTHING')
    expect(report.text).toContain("b.status = 'created'")
  })

  it('claims a canary only for the authenticated notebook identity', () => {
    const claim = claimSequencePublishCanaryOperation.build({ actor, params: { credentialId: actor.actorId, leaseSeconds: 120 } })
    expect(claim.text).toContain('instance_id = public.machine_actor_instance()')
    expect(claim.text).toContain('FOR UPDATE SKIP LOCKED')
  })
})
