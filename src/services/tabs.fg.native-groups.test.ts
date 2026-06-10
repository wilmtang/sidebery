import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import * as Settings from 'src/services/settings'
import * as Tabs from 'src/services/tabs.fg'
import { MTab, resetMTabs } from 'src/defaults/mocks.tabs.fg'

describe('Tabs.isTabVisibleInNativeGroup()', () => {
  beforeEach(() => {
    ;(browser as any).tabGroups = {
      TAB_GROUP_ID_NONE: -1,
    }
    ;(browser.tabs as any).group = () => Promise.resolve(1)

    Settings.state.nativeGroupsShowInSidebar = true
    Tabs.reactive.nativeGroups = {
      42: {
        collapsed: true,
        color: 'purple',
        id: 42,
        title: 'Group',
        windowId: 1,
      },
    }
  })

  afterEach(() => {
    delete (browser as any).tabGroups
    delete (browser.tabs as any).group
    Settings.resetSettings()
    resetMTabs()
    Tabs.reactive.nativeGroups = {}
    Tabs.reactive.nativeGroupsVersion = 0
  })

  test('hides inactive tabs in collapsed native groups', () => {
    const tab = new MTab({ groupId: 42 })

    expect(Tabs.isTabVisibleInNativeGroup(tab)).toBe(false)
  })

  test('keeps the active tab visible in a collapsed native group', () => {
    const tab = new MTab({ active: true, groupId: 42 })

    expect(Tabs.isTabVisibleInNativeGroup(tab)).toBe(true)
  })

  test('keeps tabs visible when the native group is expanded', () => {
    Tabs.reactive.nativeGroups[42].collapsed = false
    const tab = new MTab({ groupId: 42 })

    expect(Tabs.isTabVisibleInNativeGroup(tab)).toBe(true)
  })

  test('keeps native group collapse from affecting tabs when sidebar groups are disabled', () => {
    Settings.state.nativeGroupsShowInSidebar = false
    const tab = new MTab({ groupId: 42 })

    expect(Tabs.isTabVisibleInNativeGroup(tab)).toBe(true)
  })
})

describe('Tabs.getNativeGroupColorValue()', () => {
  afterEach(() => {
    Tabs.reactive.nativeGroups = {}
  })

  test('maps Firefox gray native tab groups to Sidebery grey colors', () => {
    Tabs.reactive.nativeGroups = {
      42: {
        collapsed: false,
        color: 'gray' as browser.tabGroups.Color,
        id: 42,
        title: 'Group',
        windowId: 1,
      },
    }

    expect(Tabs.normalizeNativeGroupColor('gray')).toBe('grey')
    expect(Tabs.getNativeGroupColorValue(42)).toBe('#8a8a8a')
  })

  test('falls back to toolbar color for missing or unknown native group colors', () => {
    Tabs.reactive.nativeGroups = {
      42: {
        collapsed: false,
        color: 'unknown' as browser.tabGroups.Color,
        id: 42,
        title: 'Group',
        windowId: 1,
      },
    }

    expect(Tabs.getNativeGroupColorValue(42)).toBe('#686868')
    expect(Tabs.getNativeGroupColorValue()).toBe('#686868')
  })
})
