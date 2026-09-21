import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * shadcn ships this wired to `next-themes`. The dashboard has one light theme
 * and no toggle (docs/ui-standard.md), so the dependency is removed and the
 * theme is fixed. Colours come from tokens.css rather than shadcn's palette,
 * so a toast matches every other surface in the app.
 *
 * Colour never travels alone here: each severity ships an icon as well, which
 * is the same rule Badge and StatusText follow.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--surface-1)",
          "--normal-text": "var(--text)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--success-subtle)",
          "--success-text": "var(--success)",
          "--success-border": "var(--success-border)",
          "--warning-bg": "var(--warning-subtle)",
          "--warning-text": "var(--warning)",
          "--warning-border": "var(--warning-border)",
          "--error-bg": "var(--danger-subtle)",
          "--error-text": "var(--danger)",
          "--error-border": "var(--danger-border)",
          "--border-radius": "var(--radius-card)",
        } as React.CSSProperties
      }
      toastOptions={{ classNames: { toast: "cn-toast" } }}
      {...props}
    />
  )
}

export { Toaster }
