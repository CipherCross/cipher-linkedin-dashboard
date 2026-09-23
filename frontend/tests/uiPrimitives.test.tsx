// @vitest-environment jsdom
/**
 * The shared primitives' behavioural contract (`src/ui/`).
 *
 * These are the promises every route now depends on, so a regression here is a
 * regression everywhere at once. What is asserted is behaviour, not appearance:
 * geometry and colour live in `ui.css` and are checked in the browser against
 * the gallery, because jsdom applies no stylesheet and a CSS assertion here
 * would pass while the page looked wrong.
 *
 * Specifically pinned, each because the audit found it broken somewhere:
 *   - an action is a `<button>` and a navigation is an `<a>`;
 *   - a loading button cannot be submitted twice;
 *   - an icon-only control always carries an accessible name;
 *   - a field's error is text and is wired to the control, not colour alone;
 *   - tabs expose exactly one tab stop and move with the arrow keys;
 *   - a dialog traps focus, closes on Escape, and returns focus to its trigger;
 *   - a busy dialog refuses every close path and says why;
 *   - a filter dialog changes nothing until Apply;
 *   - a duplicate person name carries what tells them apart;
 *   - a business time says Madrid and an analytics date says UTC.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Button, LinkButton, IconButton } from '../src/ui/Button'
import { TextField, RadioGroup } from '../src/ui/Field'
import { Tabs } from '../src/ui/Tabs'
import { Dialog, FilterDialog } from '../src/ui/Overlay'
import { EmptyState, SaveStatus } from '../src/ui/States'
import { ActiveFilters } from '../src/ui/Toolbar'
import { useRef, useState } from 'react'
import { Inbox } from 'lucide-react'
import { disambiguate, initialsOf, UNKNOWN_PERSON_LABEL } from '../src/ui/Identity'
import { analyticsDate, businessTimeLabelled, relativeTime } from '../src/ui/datetime'

afterEach(cleanup)

describe('Button', () => {
  it('renders an action as a button and a navigation as a link', () => {
    render(
      <MemoryRouter>
        <Button>Act</Button>
        <LinkButton to="/leads">Go</LinkButton>
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: 'Act' }).tagName).toBe('BUTTON')
    const link = screen.getByRole('link', { name: 'Go' })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/leads')
  })

  it('defaults to type="button" so a button inside a form never submits it', () => {
    render(<Button>Act</Button>)
    expect((screen.getByRole('button') as HTMLButtonElement).type).toBe('button')
  })

  it('cannot be submitted twice while loading', () => {
    const onClick = vi.fn()
    render(<Button loading onClick={onClick}>Save</Button>)
    const button = screen.getByRole('button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('gives an icon-only control an accessible name', () => {
    render(<IconButton label="Close the drawer" icon={<svg />} />)
    expect(screen.getByRole('button', { name: 'Close the drawer' })).toBeTruthy()
  })
})

describe('Field', () => {
  it('wires the label, the help text and the error to the control', () => {
    render(<TextField label="Owner email" help="Work address." error="Enter a work email." />)
    const input = screen.getByLabelText('Owner email') as HTMLInputElement
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ')
    expect(described).toHaveLength(2)
    // The error is TEXT, reachable from the control — not a red border alone.
    const message = described
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
    expect(message).toMatch(/Enter a work email/)
    expect(message).toMatch(/Work address/)
  })

  it('marks a required field on the control, not only in the label', () => {
    render(<TextField label="Name" required />)
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).required).toBe(true)
  })

  it('reports a radio group choice', () => {
    const onChange = vi.fn()
    render(
      <RadioGroup
        legend="Sentiment"
        name="s"
        value="neutral"
        onChange={onChange}
        options={[
          { value: 'positive', label: 'Positive' },
          { value: 'neutral', label: 'Neutral' },
        ]}
      />,
    )
    expect((screen.getByRole('radio', { name: 'Neutral' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Positive' }))
    expect(onChange).toHaveBeenCalledWith('positive')
  })
})

describe('Tabs', () => {
  const items = [
    { id: 'all', label: 'All' },
    { id: 'unreviewed', label: 'Unreviewed', count: 4 },
    { id: 'done', label: 'Done' },
  ]

  it('exposes exactly one tab stop', () => {
    render(<Tabs label="Queue" items={items} value="unreviewed" onChange={() => {}} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.filter((tab) => tab.getAttribute('tabindex') === '0')).toHaveLength(1)
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/Unreviewed/)
  })

  it('moves with the arrow keys and wraps at the ends', () => {
    const onChange = vi.fn()
    render(<Tabs label="Queue" items={items} value="done" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('all')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('all')
  })
})

describe('Dialog', () => {
  const Harness = ({ onClose }: { onClose: () => void }) => (
    <Dialog title="New search" onRequestClose={onClose} footer={<Button>Create</Button>}>
      <TextField label="Name" />
    </Dialog>
  )

  it('is a named modal that hides the background and takes focus', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()

    render(<Harness onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'New search' })).toBeTruthy()

    // The background is hidden from assistive technology by `aria-hidden` on
    // every sibling, which is what docs/ui-standard.md means by an inert
    // background. Base UI deliberately does not set `aria-modal` — the two are
    // alternatives, and `aria-hidden` on the siblings is the better-supported
    // one. Asserting the outcome rather than either mechanism.
    expect(trigger.getAttribute('aria-hidden')).toBe('true')

    // Focus lands one frame after open, not synchronously: Base UI's focus
    // manager queues it through requestAnimationFrame.
    //
    // The hand-rolled implementation this replaced focused synchronously on
    // purpose, because a frame never arrives in a background tab. That
    // trade-off is accepted rather than lost: the queued focus is guarded by
    // an `open` check and still applies when the tab is shown again, and a
    // dialog in a background tab cannot be typed into meanwhile. Re-verify
    // this if the focus manager's scheduling ever changes.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    expect(dialog.contains(document.activeElement)).toBe(true)
    trigger.remove()
  })

  it('closes on Escape through the same path as the Close button', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  /**
   * Scroll lock and focus RESTORATION are not asserted here, because jsdom
   * cannot observe either: Base UI locks scrolling from measured layout, which
   * jsdom does not compute, and restores focus through the same queued frame.
   *
   * Both are verified in the browser against `#/ui-gallery`, and both were
   * confirmed on the Base UI port: opening sets `body { overflow: hidden }`
   * and `aria-hidden="true"` on `#root`; Escape clears both and returns focus
   * to the element that opened the dialog. A jsdom assertion here would have
   * passed while the page misbehaved, which is the failure mode this file's
   * header warns about.
   */
})

describe('Dialog contract', () => {
  const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })

  it('places a dialog at the end edge without changing its modal contract', () => {
    const onClose = vi.fn()
    render(<Dialog placement="end" title="Filters" onRequestClose={onClose}><p>Body</p></Dialog>)
    const dialog = screen.getByRole('dialog', { name: 'Filters' })
    expect(dialog.className).toContain('ui-dialog--end')
    expect(dialog.parentElement?.className).toContain('ui-scrim--end')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('refuses Escape and Close while busy and describes why', () => {
    const onClose = vi.fn()
    render(<Dialog busy busyMessage="Publishing is in progress." title="Publish" onRequestClose={onClose}><p>Body</p></Dialog>)
    const dialog = screen.getByRole('dialog', { name: 'Publish' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    const close = screen.getByRole('button', { name: 'Close' })
    fireEvent.click(close)
    expect(onClose).not.toHaveBeenCalled()
    expect((close as HTMLButtonElement).disabled).toBe(true)
    expect(dialog.getAttribute('aria-busy')).toBe('true')
    const reason = screen.getByRole('status')
    expect(reason.textContent).toBe('Publishing is in progress.')
    expect(close.getAttribute('aria-describedby')).toBe(reason.id)
  })

  it('focuses the first control in the body by default, not Close', async () => {
    render(<Dialog title="Invite" onRequestClose={() => {}}><input aria-label="Name" /></Dialog>)
    await frame()
    expect(document.activeElement).toBe(screen.getByLabelText('Name'))
  })

  it('moves focus to the requested control on open', async () => {
    function Harness() {
      const target = useRef<HTMLInputElement>(null)
      return (
        <Dialog title="Rename" onRequestClose={() => {}} initialFocusRef={target}>
          <input aria-label="First" />
          <input aria-label="Second" ref={target} />
        </Dialog>
      )
    }
    render(<Harness />)
    await frame()
    expect(document.activeElement).toBe(screen.getByLabelText('Second'))
  })
})

describe('FilterDialog', () => {
  function Harness({ onApplied }: { onApplied: (value: string) => void }) {
    const [applied, setApplied] = useState('all')
    const [draft, setDraft] = useState<string | null>(null)
    return (
      <>
        <button type="button" onClick={() => setDraft(applied)}>Open filters</button>
        <output aria-label="Applied">{applied}</output>
        {draft !== null && (
          <FilterDialog
            selectedCount={draft === 'all' ? 0 : 1}
            onClearAll={() => setDraft('all')}
            onCancel={() => setDraft(null)}
            onApply={() => { setApplied(draft); onApplied(draft); setDraft(null) }}
          >
            <label>Owner<select value={draft} onChange={(event) => setDraft(event.target.value)}>
              <option value="all">Anyone</option>
              <option value="me">Me</option>
            </select></label>
          </FilterDialog>
        )}
      </>
    )
  }

  it('is an end-placed dialog whose footer counts the draft', () => {
    render(<Harness onApplied={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open filters' }))
    const dialog = screen.getByRole('dialog', { name: 'Filters' })
    expect(dialog.className).toContain('ui-dialog--end')
    expect(within(dialog).getByText('No filters selected')).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('Owner'), { target: { value: 'me' } })
    expect(within(dialog).getByText('1 filter selected')).toBeTruthy()
  })

  it('leaves the applied value alone on Cancel, Escape and Clear all', () => {
    const onApplied = vi.fn()
    render(<Harness onApplied={onApplied} />)
    const applied = () => screen.getByLabelText('Applied').textContent

    fireEvent.click(screen.getByRole('button', { name: 'Open filters' }))
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(applied()).toBe('all')

    fireEvent.click(screen.getByRole('button', { name: 'Open filters' }))
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'me' } })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(applied()).toBe('all')

    fireEvent.click(screen.getByRole('button', { name: 'Open filters' }))
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect((screen.getByLabelText('Owner') as HTMLSelectElement).value).toBe('all')
    expect(applied()).toBe('all')
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('commits the draft only on Apply', () => {
    const onApplied = vi.fn()
    render(<Harness onApplied={onApplied} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open filters' }))
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApplied).toHaveBeenCalledWith('me')
    expect(screen.getByLabelText('Applied').textContent).toBe('me')
  })
})

describe('state presentation', () => {
  it('marks an empty dataset and a no-match result differently', () => {
    render(<>
      <EmptyState icon={Inbox} title="No replies yet" />
      <EmptyState kind="no-match" icon={Inbox} title="No replies match these filters" />
    </>)
    expect(screen.getByText('No replies yet').closest('[data-empty-kind]')?.getAttribute('data-empty-kind')).toBe('empty')
    expect(screen.getByText('No replies match these filters').closest('[data-empty-kind]')?.getAttribute('data-empty-kind')).toBe('no-match')
  })

  it('announces a save state in words', () => {
    const { rerender } = render(<SaveStatus state="saving" />)
    expect(screen.getByRole('status').textContent).toBe('Saving…')
    rerender(<SaveStatus state="conflict" />)
    expect(screen.getByRole('status').textContent).toBe('Newer version found')
    rerender(<SaveStatus state="error" label="Could not save the draft" />)
    expect(screen.getByRole('status').textContent).toBe('Could not save the draft')
  })

  it('names every active-filter removal and keeps Clear all a button', () => {
    const onRemove = vi.fn()
    const onClearAll = vi.fn()
    render(<ActiveFilters onClearAll={onClearAll} filters={[{ id: 'owner', label: 'Owner', value: 'Me', onRemove }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Owner: Me' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onClearAll).toHaveBeenCalledTimes(1)
  })
})

describe('identity', () => {
  const names = ['Mykyta Shevchenko', 'Mykyta Shevchenko', 'Ivan Petrenko']

  it('adds the account only when the name alone is ambiguous', () => {
    expect(disambiguate('Mykyta Shevchenko', 'notebook-1', names)).toBe('Mykyta Shevchenko · notebook-1')
    expect(disambiguate('Ivan Petrenko', 'uitop', names)).toBe('Ivan Petrenko')
  })

  it('never invents a human name for an unknown contact', () => {
    expect(disambiguate(null, 'notebook-2', names)).toBe(`${UNKNOWN_PERSON_LABEL} · notebook-2`)
    expect(disambiguate('   ', null, names)).toBe(UNKNOWN_PERSON_LABEL)
    expect(initialsOf('https://www.linkedin.com/in/ACwAAA')).toBe('A')
    expect(initialsOf(null)).toBe('?')
  })
})

describe('date display', () => {
  const at = '2026-09-14T11:20:00.000Z'

  it('labels an operational time as Madrid and an analytics date as UTC', () => {
    // 11:20 UTC is 13:20 in Madrid in September.
    expect(businessTimeLabelled(at)).toBe('14 Sept, 13:20 · Madrid')
    expect(analyticsDate(at)).toBe('14 Sept 2026')
  })

  it('keeps an absolute value within reach of every relative one', () => {
    const { label, title } = relativeTime(new Date(Date.now() - 90 * 60_000))
    expect(label).toBe('2h ago')
    expect(title).toMatch(/Madrid$/)
  })
})
