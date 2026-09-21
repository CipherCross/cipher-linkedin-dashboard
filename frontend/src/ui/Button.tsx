import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { LinkProps } from 'react-router-dom'
import { Button as BaseButton } from '@base-ui/react/button'

/**
 * The one action surface. Every product action in the app renders through
 * `Button`, `LinkButton` or `IconButton` — the audit found native `<button>`
 * chrome (Refresh, Filters, Save, Close, Sign out) sitting next to three other
 * hand-rolled idioms on the same screen.
 *
 * A navigation stays a link and an action stays a button: `LinkButton` renders
 * an `<a>`/`<Link>` and therefore supports middle-click, copy-link and the
 * browser's own focus semantics, while `Button` never carries an `href`.
 *
 * `Button` and `IconButton` are Base UI buttons — that is what gives them
 * consistent disabled and activation semantics across the app. `LinkButton`
 * and `ExternalLinkButton` deliberately are NOT: Base UI's `useButton` applies
 * `role="button"` to any element that is not a native `<button>`
 * (`isNativeButton ? { type: 'button' } : { role: 'button' }`), which would
 * override the link role and break exactly the navigation semantics this file
 * exists to preserve. They render a bare `<Link>`/`<a>` carrying the same
 * classes. tests/uiPrimitives.test.tsx pins this.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'md' | 'sm'

interface CommonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Leading icon element. Replaced by a spinner while `loading`. */
  icon?: ReactNode
  block?: boolean
  children?: ReactNode
  className?: string
}

function classes(
  { variant = 'secondary', size = 'md', block, className = '' }: CommonProps,
): string {
  return [
    'ui-btn',
    `ui-btn--${variant}`,
    size === 'sm' ? 'ui-btn--sm' : '',
    block ? 'ui-btn--block' : '',
    className,
  ].filter(Boolean).join(' ')
}

/** Spinner replaces the icon in place, so the button's width never changes
 *  between idle and pending and the row it sits in cannot reflow. */
function Leading({ loading, icon }: { loading?: boolean; icon?: ReactNode }) {
  if (loading) return <span className="ui-btn__spinner" aria-hidden="true" />
  return icon ? <>{icon}</> : null
}

export type ButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
    loading?: boolean
    /** Accessible text announced while `loading`; defaults to the button label. */
    loadingLabel?: string
  }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, icon, block, className, loading, loadingLabel, children, disabled, type, ...rest },
  ref,
) {
  return (
    <BaseButton
      ref={ref}
      type={type ?? 'button'}
      className={classes({ variant, size, block, className })}
      // A pending action must not be submitted twice.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      <Leading loading={loading} icon={icon} />
      {children}
      {loading && loadingLabel && <span className="sr-only">{loadingLabel}</span>}
    </BaseButton>
  )
})

export type LinkButtonProps = CommonProps & Omit<LinkProps, 'className'>

export function LinkButton({ variant, size, icon, block, className, children, ...rest }: LinkButtonProps) {
  return (
    <Link className={classes({ variant, size, block, className })} {...rest}>
      {icon}
      {children}
    </Link>
  )
}

export type ExternalLinkButtonProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className'>

export function ExternalLinkButton({
  variant, size, icon, block, className, children, ...rest
}: ExternalLinkButtonProps) {
  return (
    <a className={classes({ variant, size, block, className })} {...rest}>
      {icon}
      {children}
    </a>
  )
}

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & {
  /** Required: an icon-only control has no visible text to name it. */
  label: string
  icon: ReactNode
  bordered?: boolean
  tone?: 'default' | 'danger'
  loading?: boolean
  className?: string
}

/** 44×44 hit area around a 20px glyph, per the product target size. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, bordered, tone = 'default', loading, className = '', disabled, type, ...rest },
  ref,
) {
  return (
    <BaseButton
      ref={ref}
      type={type ?? 'button'}
      className={[
        'ui-icon-btn',
        bordered ? 'ui-icon-btn--bordered' : '',
        tone === 'danger' ? 'ui-icon-btn--danger' : '',
        className,
      ].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="ui-btn__spinner" aria-hidden="true" /> : icon}
    </BaseButton>
  )
})
