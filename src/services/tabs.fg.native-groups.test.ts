import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as Settings from 'src/services/settings'
import * as Tabs from 'src/services/tabs.fg'
import * as Selection from 'src/services/selection.fg'
import * as Popups from 'src/services/popups.fg'
import * as Windows from 'src/services/windows.fg'
import { tabsMenuOptions } from 'src/services/menu.fg.options.tabs'
import { MTab, addMTab, resetMTabs } from 'src/defaults/mocks.tabs.fg'

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

  test('inherits visual native group membership from grouped ancestors', () => {
    const parent = addMTab({ id: 1, groupId: 42 })
    const child = addMTab({ id: 2, parentId: parent.id })

    expect(Tabs.getVisualNativeGroupId(child)).toBe(42)
  })

  test('hides inactive tree descendants of collapsed native groups', () => {
    const parent = addMTab({ id: 1, groupId: 42 })
    const child = addMTab({ id: 2, parentId: parent.id })

    expect(Tabs.isTabVisibleInNativeGroup(child)).toBe(false)
  })

  test('keeps tree descendants visible when the native group is expanded', () => {
    Tabs.reactive.nativeGroups[42].collapsed = false
    const parent = addMTab({ id: 1, groupId: 42 })
    const child = addMTab({ id: 2, parentId: parent.id })

    expect(Tabs.isTabVisibleInNativeGroup(child)).toBe(true)
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

describe('Tabs.setNativeGroupColor()', () => {
  afterEach(() => {
    delete (browser as any).tabGroups
    Tabs.reactive.nativeGroups = {}
    Tabs.reactive.nativeGroupsVersion = 0
  })

  test('updates Firefox native group color and reactive cache', async () => {
    const update = vi.fn(
      async (groupId: ID, updateProperties: browser.tabGroups.UpdateProperties) => ({
        ...Tabs.reactive.nativeGroups[groupId],
        ...updateProperties,
      })
    )
    ;(browser as any).tabGroups = { update }
    Tabs.reactive.nativeGroups = {
      42: {
        collapsed: false,
        color: 'blue',
        id: 42,
        title: 'Group',
        windowId: 1,
      },
    }

    await Tabs.setNativeGroupColor(42, 'orange')

    expect(update).toHaveBeenCalledWith(42, { color: 'orange' })
    expect(Tabs.reactive.nativeGroups[42].color).toBe('orange')
  })
})

describe('Tabs.setNativeGroupTitle()', () => {
  afterEach(() => {
    delete (browser as any).tabGroups
    Tabs.reactive.nativeGroups = {}
    Tabs.reactive.nativeGroupsVersion = 0
  })

  test('updates Firefox native group title and reactive cache', async () => {
    const update = vi.fn(
      async (groupId: ID, updateProperties: browser.tabGroups.UpdateProperties) => ({
        ...Tabs.reactive.nativeGroups[groupId],
        ...updateProperties,
      })
    )
    ;(browser as any).tabGroups = { update }
    Tabs.reactive.nativeGroups = {
      42: {
        collapsed: false,
        color: 'blue',
        id: 42,
        title: 'Old group title',
        windowId: 1,
      },
    }

    await Tabs.setNativeGroupTitle(42, '  New group title  ')

    expect(update).toHaveBeenCalledWith(42, { title: 'New group title' })
    expect(Tabs.reactive.nativeGroups[42].title).toBe('New group title')
  })
})

describe('Tabs.toggleNativeGroupCollapsed()', () => {
  afterEach(() => {
    delete (browser as any).tabGroups
    Tabs.reactive.nativeGroups = {}
    Tabs.reactive.nativeGroupsVersion = 0
  })

  test('updates Firefox native group collapsed state and reactive cache', async () => {
    const update = vi.fn(
      async (groupId: ID, updateProperties: browser.tabGroups.UpdateProperties) => ({
        ...Tabs.reactive.nativeGroups[groupId],
        ...updateProperties,
      })
    )
    ;(browser as any).tabGroups = { update }
    Tabs.reactive.nativeGroups = {
      42: {
        collapsed: false,
        color: 'blue',
        id: 42,
        title: 'Group',
        windowId: 1,
      },
    }

    await Tabs.toggleNativeGroupCollapsed(42)

    expect(update).toHaveBeenCalledWith(42, { collapsed: true })
    expect(Tabs.reactive.nativeGroups[42].collapsed).toBe(true)
  })
})

describe('Tabs.ungroupNativeGroup()', () => {
  afterEach(() => {
    delete (browser as any).tabGroups
    delete (browser.tabs as any).ungroup
    delete (browser.tabs as any).remove
    resetMTabs()
    Windows.setCurrentId(-1)
    Tabs.reactive.nativeGroups = {}
    Tabs.reactive.nativeGroupsVersion = 0
  })

  test('ungroups member tabs and closes the orphaned Sidebery group page', async () => {
    Windows.setCurrentId(1)
    const ungroup = vi.fn(async () => undefined)
    const remove = vi.fn(async () => undefined)
    ;(browser.tabs as any).ungroup = ungroup
    ;(browser.tabs as any).remove = remove
    ;(browser as any).tabGroups = { TAB_GROUP_ID_NONE: -1 }

    addMTab({ id: 5, groupId: 42, isGroup: true, title: 'Group page' })
    addMTab({ id: 6, groupId: 42, title: 'Tab A' })
    addMTab({ id: 7, groupId: 42, title: 'Tab B' })

    await Tabs.ungroupNativeGroup(42)

    expect(ungroup).toHaveBeenCalledWith([6, 7])
    expect(remove).toHaveBeenCalledWith(5)
  })

  test('ungroups normally when the group has no Sidebery group page', async () => {
    Windows.setCurrentId(1)
    const ungroup = vi.fn(async () => undefined)
    const remove = vi.fn(async () => undefined)
    ;(browser.tabs as any).ungroup = ungroup
    ;(browser.tabs as any).remove = remove
    ;(browser as any).tabGroups = { TAB_GROUP_ID_NONE: -1 }

    addMTab({ id: 6, groupId: 42, title: 'Tab A' })
    addMTab({ id: 7, groupId: 42, title: 'Tab B' })

    await Tabs.ungroupNativeGroup(42)

    expect(ungroup).toHaveBeenCalledWith([6, 7])
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('native group tab menu options', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (browser as any).tabGroups
    resetMTabs()
    Selection.resetSelection(true)
    Settings.resetSettings()
    Tabs.reactive.nativeGroups = {}
    Tabs.reactive.nativeGroupsSelectedId = -1
    Tabs.reactive.nativeGroupsVersion = 0
  })

  test('routes the normal edit-title option to the selected native group', async () => {
    const update = vi.fn(
      async (groupId: ID, updateProperties: browser.tabGroups.UpdateProperties) => ({
        ...Tabs.reactive.nativeGroups[groupId],
        ...updateProperties,
      })
    )
    ;(browser as any).tabGroups = { update }
    Tabs.reactive.nativeGroups = {
      42: {
        collapsed: false,
        color: 'blue',
        id: 42,
        title: 'Old group title',
        windowId: 1,
      },
    }
    addMTab({ id: 7, groupId: 42, title: 'First tab title' })
    Selection.selectTabs([7])
    Tabs.reactive.nativeGroupsSelectedId = 42
    const ask = vi.spyOn(Popups, 'ask').mockImplementation(async conf => {
      conf.input?.update('New group title')
      return 'save'
    })

    const option = tabsMenuOptions.editTabTitle()
    if (!option || Array.isArray(option)) throw new Error('Expected edit-title menu option')

    await option.onClick?.()

    expect(ask).toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith(42, { title: 'New group title' })
    expect(Tabs.reactive.nativeGroups[42].title).toBe('New group title')
    expect(Tabs.byId[7]?.reactive.customTitleEdit).toBe(false)
    expect(Tabs.byId[7]?.customTitle).toBeUndefined()
  })

  test('cancelling the rename dialog leaves the native group title unchanged', async () => {
    const update = vi.fn(
      async (groupId: ID, updateProperties: browser.tabGroups.UpdateProperties) => ({
        ...Tabs.reactive.nativeGroups[groupId],
        ...updateProperties,
      })
    )
    ;(browser as any).tabGroups = { update }
    Tabs.reactive.nativeGroups = {
      42: {
        collapsed: false,
        color: 'blue',
        id: 42,
        title: 'Old group title',
        windowId: 1,
      },
    }
    addMTab({ id: 7, groupId: 42, title: 'First tab title' })
    Selection.selectTabs([7])
    Tabs.reactive.nativeGroupsSelectedId = 42
    vi.spyOn(Popups, 'ask').mockImplementation(async conf => {
      conf.input?.update('New group title')
      return 'cancel'
    })

    const option = tabsMenuOptions.editTabTitle()
    if (!option || Array.isArray(option)) throw new Error('Expected edit-title menu option')

    await option.onClick?.()

    expect(update).not.toHaveBeenCalled()
    expect(Tabs.reactive.nativeGroups[42].title).toBe('Old group title')
  })

  test('hides tab-only site config from native group header menus', () => {
    ;(browser as any).tabGroups = {}
    Tabs.reactive.nativeGroups = {
      42: {
        collapsed: false,
        color: 'blue',
        id: 42,
        title: 'Group',
        windowId: 1,
      },
    }
    addMTab({ id: 7, groupId: 42 })
    Selection.selectTabs([7])
    Tabs.reactive.nativeGroupsSelectedId = 42

    expect(tabsMenuOptions.urlConf()).toBeUndefined()
  })
})
