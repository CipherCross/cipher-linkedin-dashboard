/**
 * A table row's open action, for rows that also contain their own links and
 * controls (Leads, campaign leads). The row keeps its pointer click; this real
 * button, laid over the whole row with the pointer turned off, is the keyboard
 * and screen-reader path. Its focus ring outlines the row, while every link,
 * select and tooltip underneath keeps working.
 *
 * The row must be `position: relative`. Put this in the row's first cell; the
 * route owns the handler, and the row's own `onClick` calls the same one.
 */
export function RowOpenButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    /* ui-exception(row-open-button): an unlabelled-looking button over a whole
       row is the one way to give a row containing other controls a real
       button without nesting them in it. verify: Tab to a row, Enter opens
       it, focus returns to it when what it opened closes. */
    <button
      type="button"
      data-row-open=""
      className="absolute inset-0 z-0 p-0 border-0 bg-transparent pointer-events-none focus-visible:outline-2 focus-visible:outline-app-accent focus-visible:-outline-offset-2"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onOpen()
      }}
    />
  )
}
