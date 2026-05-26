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
})
