import { useCallback, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { IconButton } from './Button'

export interface OverlayProps {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  footerNote?: ReactNode
  onRequestClose: () => void
  initialFocusRef?: RefObject<HTMLElement>
  size?: 'sm' | 'md' | 'lg' | 'xl'
  closeLabel?: string
  className?: string
  busy?: boolean
}

function OverlayPanel({
  variant, title, description, children, footer, footerNote, onRequestClose,
  initialFocusRef, size = 'md', closeLabel = 'Close', className = '', busy,
}: OverlayProps & { variant: 'dialog' | 'drawer' }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const requestClose = useCallback(() => { if (!busy) onRequestClose() }, [busy, onRequestClose])
  const handleOpenChange = useCallback((next: boolean) => { if (!next) requestClose() }, [requestClose])
  const initialFocus = useCallback(
    () => initialFocusRef?.current ?? true,
    [initialFocusRef],
  )

  return (
    <BaseDialog.Root open onOpenChange={handleOpenChange} modal>
      <BaseDialog.Portal>
        <div className={`ui-scrim ${variant === 'drawer' ? 'ui-scrim--end' : 'ui-scrim--center'}`}>
          <BaseDialog.Popup
            ref={panelRef}
            initialFocus={initialFocus}
            className={['ui-dialog', variant === 'drawer' ? 'ui-drawer' : `ui-dialog--${size}`, className].filter(Boolean).join(' ')}
          >
            <div className="ui-dialog__header">
              <div>
                <BaseDialog.Title className="ui-dialog__title">{title}</BaseDialog.Title>
                {description && <BaseDialog.Description className="ui-dialog__description">{description}</BaseDialog.Description>}
              </div>
              <IconButton className="ui-dialog__close" label={closeLabel} icon={<X size={20} aria-hidden="true" />} onClick={requestClose} disabled={busy} />
            </div>
            <div className="ui-dialog__body">{children}</div>
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

export function Dialog(props: OverlayProps) { return <OverlayPanel variant="dialog" {...props} /> }
export function Drawer(props: OverlayProps) { return <OverlayPanel variant="drawer" {...props} /> }
