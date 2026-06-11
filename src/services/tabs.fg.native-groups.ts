import type * as T from 'src/types'
import * as D from 'src/defaults'
import * as Utils from 'src/utils'
import { translate } from 'src/dict'
import * as Logs from 'src/services/logs'
import * as Settings from 'src/services/settings'
import * as Sidebar from 'src/services/sidebar.fg'
import * as Windows from 'src/services/windows.fg'
import * as Tabs from 'src/services/tabs.fg'
import * as Popups from 'src/services/popups.fg'

const FALLBACK_GROUP_ID_NONE = -1
const groupPageCreationLocks = new Set<ID>()
const NATIVE_GROUP_COLOR_FALLBACK: browser.ColorName = 'toolbar'
const NATIVE_GROUP_COLOR_ALIASES: Record<string, browser.ColorName> = {
  gray: 'grey',
  grey: 'grey',
}

let listenersAreSet = false

export function nativeGroupsSupported(): boolean {
  return !!browser.tabGroups && typeof browser.tabs.group === 'function'
}

export function getNativeGroupIdNone(): ID {
  return browser.tabGroups?.TAB_GROUP_ID_NONE ?? FALLBACK_GROUP_ID_NONE
}

export function hasNativeGroup(tab?: T.Tab | null): boolean {
  if (!tab || !nativeGroupsSupported()) return false
  return tab.groupId !== undefined && tab.groupId !== getNativeGroupIdNone()
}

export function getVisualNativeGroupId(tab?: T.Tab | null): ID | undefined {
  if (!tab || !nativeGroupsSupported()) return
  if (hasNativeGroup(tab)) return tab.groupId

  const seen = new Set<ID>([tab.id])
  let parent = Tabs.byId[tab.parentId]

  while (parent && !seen.has(parent.id)) {
    if (hasNativeGroup(parent)) return parent.groupId
    seen.add(parent.id)
    parent = Tabs.byId[parent.parentId]
  }
}

export function getNativeGroup(groupId?: ID): T.NativeTabGroup | undefined {
  if (groupId === undefined || groupId === getNativeGroupIdNone()) return
  return Tabs.reactive.nativeGroups[groupId]
}

export function getNativeGroupTitle(groupId: ID): string {
  return getNativeGroup(groupId)?.title || browser.i18n.getMessage('defaultGroupName') || 'Group'
}

export function normalizeNativeGroupColor(color?: string | null): browser.ColorName {
  if (!color) return NATIVE_GROUP_COLOR_FALLBACK

  const alias = NATIVE_GROUP_COLOR_ALIASES[color]
  if (alias) return alias

  if (Object.hasOwn(D.RGB_COLORS, color)) return color as browser.ColorName

  return NATIVE_GROUP_COLOR_FALLBACK
}

export function getNativeGroupColorValue(groupOrId?: ID | T.NativeTabGroup): string {
  const group = typeof groupOrId === 'object' ? groupOrId : getNativeGroup(groupOrId)
  return D.RGB_COLORS[normalizeNativeGroupColor(group?.color)]
}

function normalizeGroup(group: browser.tabGroups.TabGroup): T.NativeTabGroup {
  return {
    ...group,
    title: group.title ?? '',
  }
}

function bumpVersion(): void {
  Tabs.reactive.nativeGroupsVersion++
}

function setGroup(group: browser.tabGroups.TabGroup): void {
  Tabs.reactive.nativeGroups[group.id] = normalizeGroup(group)
  bumpVersion()
}

function deleteGroup(groupId: ID): void {
  delete Tabs.reactive.nativeGroups[groupId]
  if (Tabs.reactive.nativeGroupsSelectedId === groupId) {
    Tabs.reactive.nativeGroupsSelectedId = D.NOID
  }
  bumpVersion()
}

export async function loadNativeGroups(): Promise<void> {
  if (!nativeGroupsSupported()) return

  for (const id of Object.keys(Tabs.reactive.nativeGroups)) {
    delete Tabs.reactive.nativeGroups[id as ID]
  }

  const groups = await browser.tabGroups.query({ windowId: Windows.id }).catch(err => {
    Logs.warn('Tabs.loadNativeGroups: Cannot query native groups:', err)
    return []
  })

  for (const group of groups) {
    Tabs.reactive.nativeGroups[group.id] = normalizeGroup(group)
  }
  bumpVersion()
}

export function setupNativeGroupsListeners(): void {
  if (!nativeGroupsSupported()) return
  if (listenersAreSet) return

  browser.tabGroups.onCreated.addListener(onNativeGroupCreated)
  browser.tabGroups.onUpdated.addListener(onNativeGroupUpdated)
  browser.tabGroups.onMoved.addListener(onNativeGroupMoved)
  browser.tabGroups.onRemoved.addListener(onNativeGroupRemoved)
  listenersAreSet = true
}

export function resetNativeGroupsListeners(): void {
  if (!nativeGroupsSupported() || !listenersAreSet) return

  browser.tabGroups.onCreated.removeListener(onNativeGroupCreated)
  browser.tabGroups.onUpdated.removeListener(onNativeGroupUpdated)
  browser.tabGroups.onMoved.removeListener(onNativeGroupMoved)
  browser.tabGroups.onRemoved.removeListener(onNativeGroupRemoved)
  listenersAreSet = false
}

function onNativeGroupCreated(group: browser.tabGroups.TabGroup): void {
  if (group.windowId !== Windows.id) return
  setGroup(group)
  Sidebar.recalcVisibleTabs()
  Sidebar.updatePanelBoundsDebounced(128)

  if (Settings.state.nativeGroupsCreateSideberyPage) {
    setTimeout(() => {
      createSideberyGroupPage(group.id).catch(err => {
        Logs.err('Tabs.onNativeGroupCreated: Cannot create Sidebery group page:', err)
      })
    }, 120)
  }
}

function onNativeGroupUpdated(group: browser.tabGroups.TabGroup): void {
  if (group.windowId !== Windows.id) return
  setGroup(group)
  syncSideberyGroupPageTitle(group.id)
  updateSideberyGroupPage(group.id)
  Sidebar.recalcVisibleTabs()
  Sidebar.updatePanelBoundsDebounced(128)
}

function onNativeGroupMoved(group: browser.tabGroups.TabGroup): void {
  if (group.windowId !== Windows.id) return
  setGroup(group)
  Sidebar.recalcVisibleTabs()
  Sidebar.updatePanelBoundsDebounced(128)
}

function onNativeGroupRemoved(group: browser.tabGroups.TabGroup): void {
  if (group.windowId !== Windows.id) return
  deleteGroup(group.id)
  Sidebar.recalcVisibleTabs()
  Sidebar.updatePanelBoundsDebounced(128)
}

export function onNativeGroupMembershipChanged(
  tab: T.Tab,
  oldGroupId: ID | undefined,
  newGroupId: ID | undefined
): void {
  if (!nativeGroupsSupported()) return

  if (oldGroupId !== undefined && oldGroupId !== getNativeGroupIdNone()) {
    updateSideberyGroupPage(oldGroupId)
  }
  if (newGroupId !== undefined && newGroupId !== getNativeGroupIdNone()) {
    updateSideberyGroupPage(newGroupId)
  }

  Sidebar.recalcVisibleTabs(tab.panelId)
  Sidebar.updatePanelBoundsDebounced(128)
}

export function isNativeGroupCollapsed(groupId?: ID): boolean {
  if (groupId === undefined || groupId === getNativeGroupIdNone()) return false
  return !!Tabs.reactive.nativeGroups[groupId]?.collapsed
}

export function isTabVisibleInNativeGroup(tab?: T.Tab): boolean {
  if (!Settings.state.nativeGroupsShowInSidebar) return true
  if (!tab) return true

  const groupId = getVisualNativeGroupId(tab)
  if (groupId === undefined) return true
  if (!isNativeGroupCollapsed(groupId)) return true

  return tab.active || tab.reactive.active
}

export function shouldShowNativeGroupBeforeTab(tab?: T.Tab, prevTab?: T.Tab): boolean {
  if (!Settings.state.nativeGroupsShowInSidebar) return false
  if (!tab) return false

  const groupId = getVisualNativeGroupId(tab)
  if (groupId === undefined) return false

  return groupId !== getVisualNativeGroupId(prevTab)
}

export function getNativeGroupTabs(groupId: ID, includeSideberyPage = false): T.Tab[] {
  const tabs: T.Tab[] = []
  for (const tab of Tabs.list) {
    if (tab.windowId !== Windows.id) continue
    if (tab.groupId !== groupId) continue
    if (!includeSideberyPage && tab.isGroup) continue
    tabs.push(tab)
  }
  return tabs
}

export function getSideberyGroupPageForNativeGroup(groupId: ID): T.Tab | undefined {
  return Tabs.list.find(tab => tab.groupId === groupId && tab.isGroup)
}

export async function createSideberyGroupPage(groupId: ID): Promise<T.Tab | undefined> {
  if (!nativeGroupsSupported()) return
  if (groupId === getNativeGroupIdNone()) return
  if (groupPageCreationLocks.has(groupId)) return getSideberyGroupPageForNativeGroup(groupId)

  const existing = getSideberyGroupPageForNativeGroup(groupId)
  if (existing) {
    await ensureSideberyGroupPageIsFirst(groupId, existing)
    return existing
  }

  const groupTabs = getNativeGroupTabs(groupId)
  const firstTab = groupTabs[0]
  if (!firstTab) return

  groupPageCreationLocks.add(groupId)
  const newTabIndex = firstTab.index
  try {
    const group = getNativeGroup(groupId)
    const title = group?.title || firstTab.title
    Tabs.setNewTabPosition(newTabIndex, D.NOID, firstTab.panelId)

    const groupPage = await browser.tabs
      .create({
        active: false,
        cookieStoreId: firstTab.cookieStoreId,
        index: newTabIndex,
        url: Utils.createGroupUrl(title),
        windowId: Windows.id,
      })
      .catch(err => {
        // Drop the reserved new-tab position so a stale entry can't mis-place
        // the next tab that happens to be created at this index.
        delete Tabs.newTabsPosition[newTabIndex]
        Logs.err('Tabs.createSideberyGroupPage: Cannot create group page:', err)
        return undefined
      })
    if (!groupPage?.id) return

    await browser.tabs.group({ tabIds: groupPage.id, groupId }).catch(err => {
      Logs.warn('Tabs.createSideberyGroupPage: Cannot group group page:', err)
    })
    await browser.tabs.move(groupPage.id, { index: newTabIndex }).catch(() => undefined)

    return Tabs.byId[groupPage.id]
  } catch (err) {
    Logs.err('Tabs.createSideberyGroupPage: Cannot create group page:', err)
  } finally {
    groupPageCreationLocks.delete(groupId)
  }
}

async function ensureSideberyGroupPageIsFirst(groupId: ID, groupPage: T.Tab): Promise<void> {
  const firstTab = getNativeGroupTabs(groupId, true)[0]
  if (!firstTab || firstTab.id === groupPage.id) return

  await browser.tabs.move(groupPage.id, { index: firstTab.index }).catch(err => {
    Logs.warn('Tabs.ensureSideberyGroupPageIsFirst: Cannot move group page:', err)
  })
}

export function updateSideberyGroupPage(groupId: ID): void {
  const groupPage = getSideberyGroupPageForNativeGroup(groupId)
  if (groupPage && !groupPage.discarded) Tabs.updateGroupOrItsChild(groupPage)
}

function syncSideberyGroupPageTitle(groupId: ID): void {
  const groupPage = getSideberyGroupPageForNativeGroup(groupId)
  const group = getNativeGroup(groupId)
  if (!groupPage || !group?.title) return

  const currentName = Utils.getGroupName(groupPage.url)
  if (currentName === group.title) return

  // Replace only the title (prefix) portion of the hash, preserving any IPPC
  // channel suffix (`~!<chId>!ch!~`) and id so the group page's message channel
  // keeps working after a rename. A blind PAGE_HASH_RE replace would drop them.
  const hashIndex = groupPage.url.indexOf('#')
  const reResult = D.PAGE_HASH_RE.exec(groupPage.url)
  if (hashIndex === -1 || !reResult) return

  const rawPrefix = reResult.groups?.prefix ?? ''
  const hashBody = groupPage.url.slice(hashIndex + 1)
  const suffix = hashBody.slice(rawPrefix.length)
  const newUrl = groupPage.url.slice(0, hashIndex + 1) + encodeURIComponent(group.title) + suffix

  browser.tabs
    .update(groupPage.id, { url: newUrl })
    .catch(err => Logs.warn('Tabs.syncSideberyGroupPageTitle: Cannot update group page:', err))
}

export async function toggleNativeGroupCollapsed(groupId: ID): Promise<void> {
  const group = getNativeGroup(groupId)
  if (!group) return

  const updatedGroup = await browser.tabGroups
    .update(groupId, { collapsed: !group.collapsed })
    .catch(err => {
      Logs.err('Tabs.toggleNativeGroupCollapsed: Cannot update group:', err)
    })
  if (updatedGroup) setGroup(updatedGroup)
}

export async function setNativeGroupTitle(groupId: ID, title: string): Promise<void> {
  const group = getNativeGroup(groupId)
  if (!group) return

  const updatedGroup = await browser.tabGroups
    .update(groupId, { title: title.trim() })
    .catch(err => {
      Logs.err('Tabs.setNativeGroupTitle: Cannot rename group:', err)
    })
  if (updatedGroup) setGroup(updatedGroup)
}

export async function renameNativeGroup(groupId: ID): Promise<void> {
  const group = getNativeGroup(groupId)
  if (!group) return

  // window.prompt is unreliable/blocked in Firefox sidebar documents — use
  // Sidebery's in-app dialog popup with a text input instead.
  let title = group.title
  const result = await Popups.ask({
    title: translate('dialog.native_group_rename.title'),
    input: {
      value: group.title,
      placeholder: translate('dialog.native_group_rename.placeholder'),
      update: value => (title = value),
    },
    buttons: [
      { value: 'save', label: translate('btn.save') },
      { value: 'cancel', label: translate('btn.cancel'), warn: true },
    ],
    buttonsDefaultFocus: 'save',
  })
  if (result !== 'save') return

  await setNativeGroupTitle(groupId, title)
}

export async function setNativeGroupColor(
  groupId: ID,
  color: browser.tabGroups.Color
): Promise<void> {
  const group = getNativeGroup(groupId)
  if (!group) return

  const updatedGroup = await browser.tabGroups.update(groupId, { color }).catch(err => {
    Logs.err('Tabs.setNativeGroupColor: Cannot set group color:', err)
  })
  if (updatedGroup) setGroup(updatedGroup)
}

export async function ungroupNativeGroup(groupId: ID): Promise<void> {
  const groupTabs = getNativeGroupTabs(groupId, true)
  if (!groupTabs.length) return

  // The Sidebery group page only makes sense as the head of a native group.
  // When the group is dissolved, close it instead of leaving an orphan tab
  // that renders a group with no members.
  const groupPage = groupTabs.find(tab => tab.isGroup)
  const tabIds = groupTabs.filter(tab => !tab.isGroup).map(tab => tab.id)

  if (tabIds.length) {
    await browser.tabs.ungroup(tabIds).catch(err => {
      Logs.err('Tabs.ungroupNativeGroup: Cannot ungroup tabs:', err)
    })
  }

  if (groupPage) {
    await browser.tabs.remove(groupPage.id).catch(err => {
      Logs.warn('Tabs.ungroupNativeGroup: Cannot remove group page:', err)
    })
  }
}
