import { describe, expect, test } from 'vitest'
import type { SettingsState } from 'src/types'
import { migrateStoredSettings } from 'src/services/settings'

describe('Settings.migrateStoredSettings()', () => {
  test('maps legacy skipEmptyPanels to hideEmptyPanels when the new setting is absent', () => {
    const settings = { skipEmptyPanels: true } as SettingsState

    expect(migrateStoredSettings(settings)).toBe(true)
    expect(settings.hideEmptyPanels).toBe(true)
    expect(settings.skipEmptyPanels).toBeUndefined()
  })

  test('does not override an explicit hideEmptyPanels value', () => {
    const settings = { hideEmptyPanels: false, skipEmptyPanels: true } as SettingsState

    expect(migrateStoredSettings(settings)).toBe(true)
    expect(settings.hideEmptyPanels).toBe(false)
    expect(settings.skipEmptyPanels).toBeUndefined()
  })
})
