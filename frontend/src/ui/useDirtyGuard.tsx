import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from './Button'
import { Dialog } from './Overlay'

/**
 * One contract for closing an edited form.
 *
 * A clean form closes at once. A dirty one asks first — and it asks the same way
 * for Escape, for the Close button, for a backdrop click and for navigating
 * away. `Keep editing` returns focus to the field the user was in;
 * `Discard changes` drops only the unsaved draft and then performs the deferred
 * close or navigation.
 *
 * Replies already had a guard of its own and keeps it; this exists so that the
 * forms that had none — New search closed straight through Escape, the backdrop
 * and Close — get the same behaviour instead of a second bespoke one.
 */
export function useDirtyGuard(dirty: boolean) {
  const [pending, setPending] = useState<null | (() => void)>(null)
  const lastFocused = useRef<HTMLElement | null>(null)

  /** Wrap any close/navigate action. Returns immediately when the form is clean. */
  const guard = useCallback(
    (action: () => void) => {
      if (!dirty) {
        action()
        return
      }
      lastFocused.current = document.activeElement as HTMLElement | null
      // Stored as a thunk: setState would otherwise *call* the function.
      setPending(() => action)
    },
    [dirty],
  )

  const keepEditing = useCallback(() => {
    setPending(null)
    requestAnimationFrame(() => lastFocused.current?.focus?.())
  }, [])

  const discard = useCallback(() => {
    const action = pending
    setPending(null)
    action?.()
  }, [pending])

  const prompt: ReactNode = pending ? (
    <Dialog
      size="sm"
      title="Discard unsaved changes?"
      description="This form has changes that have not been saved."
      onRequestClose={keepEditing}
      closeLabel="Keep editing"
      footer={
        <>
          <Button variant="secondary" onClick={keepEditing}>Keep editing</Button>
          <Button variant="danger" onClick={discard}>Discard changes</Button>
        </>
      }
    >
      <p>
        Discarding removes only the unsaved draft. Anything already saved is kept.
      </p>
    </Dialog>
  ) : null

  return { guard, prompt, blocked: pending !== null }
}
