import { useCallback, useEffect, useId, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { Button, IconButton } from './Button'
import { COPY } from './labels'

/**
 * The one modal surface. `placement="center"` is the ordinary dialog;
 * `placement="end"` is the same modal contract docked to the end edge at
 * 560px, used by FilterDialog. Neither is a persistent pane: a region that
 * stays open beside the page is not a modal and must not use this.
 *
 * Every close path — Escape, backdrop, and the Close button — goes through
 * `onRequestClose`, so a route's dirty guard sees all of them. The Close button
 * is Base UI's Dialog.Close, which is what a touch screen reader expects as the
 * dismiss control inside a modal popup.
 *
 * While `busy`, every close path is refused and the reason is announced, so an
 * in-flight save cannot be abandoned by an accidental Escape.
 */
export interface DialogProps {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  footerNote?: ReactNode
  onRequestClose: () => void
  /** Where focus lands on open. Defaults to the first control in the body,
   *  then to the first focusable element (Close) when the body has none. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Where focus returns on close. Defaults to the element focused at open. */
  finalFocusRef?: RefObject<HTMLElement | null>
  placement?: 'center' | 'end'
  /** Width of a centered dialog. An end dialog is always 560px at most. */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  closeLabel?: string
  className?: string
  busy?: boolean
  /** Shown and announced while `busy`; also describes the disabled Close button. */
  busyMessage?: string
}

const BODY_FOCUS_TARGETS = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

export function Dialog({
  title, description, children, footer, footerNote, onRequestClose,
  initialFocusRef, finalFocusRef, placement = 'center', size = 'md',
  closeLabel = 'Close', className = '', busy,
  busyMessage = 'Wait for the current action to finish before closing.',
}: DialogProps) {
  const busyId = useId()
  const handleOpenChange = useCallback(
    (next: boolean) => { if (!next && !busy) onRequestClose() },
    [busy, onRequestClose],
  )
  const bodyRef = useRef<HTMLDivElement>(null)
  const initialFocus = useCallback(
    () => initialFocusRef?.current
      ?? bodyRef.current?.querySelector<HTMLElement>(BODY_FOCUS_TARGETS)
      ?? true,
    [initialFocusRef],
  )
  const finalFocus = useCallback(() => finalFocusRef?.current ?? true, [finalFocusRef])
  const popupRef = useRef<HTMLDivElement>(null)

  // When one dialog hands over to another (viewer → editor), the closing one
  // restores focus to its trigger in the page after the next one has already
  // taken it. While this is the topmost dialog, focus that lands in the page
  // behind it is brought back. Portalled popovers render outside #root and are
  // left alone.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const popup = popupRef.current
      const target = event.target as Node | null
      if (!popup || !target || popup.contains(target)) return
      if (!document.getElementById('root')?.contains(target)) return
      const dialogs = document.querySelectorAll('[role="dialog"]')
      if (dialogs[dialogs.length - 1] !== popup) return
      const next = bodyRef.current?.querySelector<HTMLElement>(BODY_FOCUS_TARGETS)
        ?? popup.querySelector<HTMLElement>(BODY_FOCUS_TARGETS)
      next?.focus()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])

  return (
    <BaseDialog.Root open onOpenChange={handleOpenChange} modal>
      <BaseDialog.Portal>
        <div className={placement === 'end' ? 'ui-scrim ui-scrim--end' : 'ui-scrim ui-scrim--center'}>
          <BaseDialog.Popup
            ref={popupRef}
            initialFocus={initialFocus}
            finalFocus={finalFocus}
            aria-busy={busy || undefined}
            className={['ui-dialog', placement === 'end' ? 'ui-dialog--end' : `ui-dialog--${size}`, className].filter(Boolean).join(' ')}
          >
            <div className="ui-dialog__header">
              <div>
                <BaseDialog.Title className="ui-dialog__title">{title}</BaseDialog.Title>
                {description && <BaseDialog.Description className="ui-dialog__description">{description}</BaseDialog.Description>}
                {busy && <p id={busyId} className="ui-dialog__busy" role="status">{busyMessage}</p>}
              </div>
              <BaseDialog.Close
                disabled={busy}
                aria-describedby={busy ? busyId : undefined}
                render={<IconButton className="ui-dialog__close" label={closeLabel} icon={<X size={20} aria-hidden="true" />} />}
              />
            </div>
            <div className="ui-dialog__body" ref={bodyRef}>{children}</div>
            {(footer || footerNote) && (
              <div className="ui-dialog__footer">
                {footerNote && <span className="ui-dialog__footer-note">{footerNote}</span>}
                {footer}
              </div>
            )}
          </BaseDialog.Popup>
        </div>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

/**
 * Filters beyond search and one or two primary selectors. The route owns the
 * draft: it opens this with a copy of the applied values, edits that copy, and
 * commits every key at once in `onApply`. Cancel, Escape and the backdrop all
 * call `onCancel`, which must leave the URL, data, selection and scroll alone.
 * `onClearAll` clears the draft only; nothing changes until Apply.
 */
export function FilterDialog({
  title = COPY.filters, description, selectedCount, onClearAll, onCancel, onApply,
  children, initialFocusRef,
}: {
  title?: ReactNode
  description?: ReactNode
  /** Filters set in the draft, shown in the footer. */
  selectedCount: number
  onClearAll: () => void
  onCancel: () => void
  onApply: () => void
  children: ReactNode
  initialFocusRef?: RefObject<HTMLElement | null>
}) {
  return (
    <Dialog
      placement="end"
      title={title}
      description={description}
      onRequestClose={onCancel}
      initialFocusRef={initialFocusRef}
      footerNote={selectedCount ? `${selectedCount} filter${selectedCount === 1 ? '' : 's'} selected` : 'No filters selected'}
      footer={<>
        <Button variant="ghost" onClick={onClearAll}>{COPY.clearAll}</Button>
        <Button variant="secondary" onClick={onCancel}>{COPY.cancel}</Button>
        <Button variant="primary" onClick={onApply}>{COPY.apply}</Button>
      </>}
    >
      {children}
    </Dialog>
  )
}
