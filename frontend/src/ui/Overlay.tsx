import { useCallback, useEffect, useId, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { IconButton } from './Button'

/**
 * One behavioural contract for every modal surface: role and accessible name,
 * initial focus, a focus trap, an inert background, Escape, scroll lock, focus
 * returned to the trigger, and stacking order for nested overlays.
 *
 * `Dialog` and `Drawer` differ only in shape and semantics — a dialog is a task
 * you finish, a drawer is a context you work beside. A *persistent* pane (the
 * Replies inspector, the sequence comments rail) is not a modal and must not be
 * built from either.
 *
 * Closing an edited form goes through `onRequestClose`, which is where the
 * shared dirty guard lives: a clean form closes at once, a dirty one asks
 * `Keep editing` / `Discard changes` first.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Depth counter: the outermost overlay owns the scroll lock, so closing a
 *  nested one does not hand scrolling back to the page underneath. */
let openOverlays = 0

function useOverlayBehaviour(
  panelRef: RefObject<HTMLElement>,
  onRequestClose: () => void,
  initialFocusRef?: RefObject<HTMLElement>,
) {
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const root = document.getElementById('root')

    openOverlays += 1
    const previousOverflow = document.body.style.overflow
    if (openOverlays === 1) document.body.style.overflow = 'hidden'
    if (root && openOverlays === 1) root.setAttribute('inert', '')

    const focusTarget =
      initialFocusRef?.current ??
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      panelRef.current
    requestAnimationFrame(() => focusTarget?.focus())

    return () => {
      openOverlays -= 1
      if (openOverlays === 0) {
        document.body.style.overflow = previousOverflow
        root?.removeAttribute('inert')
      }
      previouslyFocused?.focus?.()
    }
    // Mount/unmount only: re-running would steal focus mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onRequestClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => element.getClientRects().length > 0)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [onRequestClose, panelRef],
  )
}

export interface OverlayProps {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  /** Footer actions. Rendered in a fixed bar so Save is always in the viewport. */
  footer?: ReactNode
  footerNote?: ReactNode
  /** Runs the dirty guard, then closes. Escape, Close and the backdrop all use it. */
  onRequestClose: () => void
  initialFocusRef?: RefObject<HTMLElement>
  size?: 'sm' | 'md' | 'lg' | 'xl'
  closeLabel?: string
  className?: string
  /** While true the panel cannot be dismissed — a submit is in flight. */
  busy?: boolean
}

function OverlayPanel({
  variant, title, description, children, footer, footerNote, onRequestClose,
  initialFocusRef, size = 'md', closeLabel = 'Close', className = '', busy,
}: OverlayProps & { variant: 'dialog' | 'drawer' }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const requestClose = useCallback(() => {
    if (!busy) onRequestClose()
  }, [busy, onRequestClose])
  const onKeyDown = useOverlayBehaviour(panelRef, requestClose, initialFocusRef)

  return createPortal(
    <div
      className={`ui-scrim ${variant === 'drawer' ? 'ui-scrim--end' : 'ui-scrim--center'}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={[
          'ui-dialog',
          variant === 'drawer' ? 'ui-drawer' : `ui-dialog--${size}`,
          className,
        ].filter(Boolean).join(' ')}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="ui-dialog__header">
          <div>
            <h2 className="ui-dialog__title" id={titleId}>{title}</h2>
            {description && (
              <p className="ui-dialog__description" id={descriptionId}>{description}</p>
            )}
          </div>
          <IconButton
            className="ui-dialog__close"
            label={closeLabel}
            icon={<X size={20} aria-hidden="true" />}
            onClick={requestClose}
            disabled={busy}
          />
        </div>
        <div className="ui-dialog__body">{children}</div>
        {(footer || footerNote) && (
          <div className="ui-dialog__footer">
            {footerNote && <span className="ui-dialog__footer-note">{footerNote}</span>}
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

export function Dialog(props: OverlayProps) {
  return <OverlayPanel variant="dialog" {...props} />
}

export function Drawer(props: OverlayProps) {
  return <OverlayPanel variant="drawer" {...props} />
}
