// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QuickNavigation } from '../src/components/QuickNavigation'
import type { DashboardData, Instance } from '../src/lib/types'

const data = {
  instances: [{
    id: 'notebook-1',
    label: 'Notebook 1',
    account_name: 'Alyona Account',
  } as Instance],
  campaigns: [],
} as DashboardData

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

afterEach(() => cleanup())

describe('QuickNavigation', () => {
  it('opens from the global shortcut', () => {
    const onOpen = vi.fn()
    render(
      <MemoryRouter>
        <QuickNavigation
          open={false}
          data={data}
          isAdmin={false}
          onOpen={onOpen}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    )

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('finds a removed sidebar account and opens it with the keyboard', () => {
    const onClose = vi.fn()
    render(
      <MemoryRouter initialEntries={['/']}>
        <QuickNavigation
          open
          data={data}
          isAdmin={false}
          onOpen={vi.fn()}
          onClose={onClose}
        />
        <LocationProbe />
      </MemoryRouter>,
    )

    const search = screen.getByRole('combobox', { name: 'Search destinations' })
    fireEvent.change(search, { target: { value: 'alyona' } })
    expect(screen.getByRole('option', { name: /Alyona Account/ })).not.toBeNull()
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(screen.getByTestId('location').textContent).toBe('/account/notebook-1')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on Escape without navigating', () => {
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <QuickNavigation
          open
          data={data}
          isAdmin={false}
          onOpen={vi.fn()}
          onClose={onClose}
        />
      </MemoryRouter>,
    )

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
