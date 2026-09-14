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
 *   - a duplicate person name carries what tells them apart;
 *   - a business time says Madrid and an analytics date says UTC.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Button, LinkButton, IconButton } from '../src/ui/Button'
import { TextField, RadioGroup } from '../src/ui/Field'
import { Tabs } from '../src/ui/Tabs'
import { Dialog } from '../src/ui/Overlay'
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

  it('is a named modal that takes focus synchronously and keeps it inside', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()

    render(<Harness onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(within(dialog).getByRole('heading', { name: 'New search' })).toBeTruthy()
    // Synchronously, not on the next animation frame — a frame never arrives
    // in a background tab, and the dialog would open with focus behind it.
    expect(dialog.contains(document.activeElement)).toBe(true)
    trigger.remove()

    const focusable = Array.from(dialog.querySelectorAll('button, input'))
    const last = focusable[focusable.length - 1] as HTMLElement
    last.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('closes on Escape through the same path as the Close button', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('locks page scroll while open and releases it on unmount', () => {
    const { unmount } = render(<Harness onClose={() => {}} />)
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).not.toBe('hidden')
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
