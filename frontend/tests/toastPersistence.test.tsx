// @vitest-environment jsdom
/**
 * One product rule survives the move to Sonner: **an error stays until it is
 * dismissed**, everything else fades after five seconds.
 *
 * It is not Sonner's default, it is a single option on one call, and an error
 * the operator never saw is the reason the rule exists at all — so it is
 * pinned here rather than left to a comment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const calls: Array<{ kind: string; message: string; opts?: { duration?: number } }> = []
vi.mock('sonner', () => ({
  toast: {
    success: (message: string, opts?: { duration?: number }) => calls.push({ kind: 'success', message, opts }),
    error: (message: string, opts?: { duration?: number }) => calls.push({ kind: 'error', message, opts }),
    info: (message: string, opts?: { duration?: number }) => calls.push({ kind: 'info', message, opts }),
  },
  Toaster: () => null,
}))

const { useToast } = await import('../src/lib/ToastContext')

beforeEach(() => { calls.length = 0 })

describe('toast durations', () => {
  it('keeps an error on screen until it is dismissed', () => {
    const { result } = renderHook(() => useToast())
    result.current.error('Publish failed')
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe('error')
    expect(calls[0].opts?.duration).toBe(Infinity)
  })

  it('auto-dismisses everything that is not an error', () => {
    const { result } = renderHook(() => useToast())
    result.current.success('Sequence published')
    result.current.info('Sync started')
    result.current.show('Plain message')
    expect(calls.map((c) => c.kind)).toEqual(['success', 'info', 'info'])
    for (const call of calls) expect(call.opts?.duration).toBe(5000)
  })

  it('routes show() through the kind it is given', () => {
    const { result } = renderHook(() => useToast())
    result.current.show('Nope', 'error')
    expect(calls[0].kind).toBe('error')
    expect(calls[0].opts?.duration).toBe(Infinity)
  })
})
