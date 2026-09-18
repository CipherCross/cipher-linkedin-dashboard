/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVisibleInterval } from '../src/lib/useVisibleInterval'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('background database polling', () => {
  it('pauses hidden tabs and checks immediately on return, then resumes polling', () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const refresh = vi.fn()
    const { unmount } = renderHook(() => useVisibleInterval(refresh, 60_000))
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(refresh).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(30 * 60_000)
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(refresh).toHaveBeenCalledTimes(2)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(refresh).toHaveBeenCalledTimes(3)
    unmount()
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(60_000)
    })
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('stops session checks when authentication is no longer ready', () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const refresh = vi.fn()
    const { rerender } = renderHook(({ delay }) => useVisibleInterval(refresh, delay), {
      initialProps: { delay: 60_000 as number | null },
    })
    rerender({ delay: null })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(60_000)
    })
    expect(refresh).not.toHaveBeenCalled()
  })
})
