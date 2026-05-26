import type * as T from 'src/types'
import * as D from 'src/defaults'
import * as Utils from 'src/utils'
import * as Logs from 'src/services/logs'
import * as Settings from 'src/services/settings'
import * as Sidebar from 'src/services/sidebar.fg'
import * as Windows from 'src/services/windows.fg'
import * as Tabs from 'src/services/tabs.fg'

const FALLBACK_GROUP_ID_NONE = -1
const groupPageCreationLocks = new Set<ID>()

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

export function getNativeGroup(groupId?: ID): T.NativeTabGroup | undefined {
  if (groupId === undefined || groupId === getNativeGroupIdNone()) return
  return Tabs.reactive.nativeGroups[groupId]
}

export function getNativeGroupTitle(groupId: ID): string {
  return getNativeGroup(groupId)?.title || browser.i18n.getMessage('defaultGroupName') || 'Group'
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
    setTimeout(() => createSideberyGroupPage(group.id), 120)
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
  if (!hasNativeGroup(tab)) return true
  if (!tab) return true
  if (!isNativeGroupCollapsed(tab.groupId)) return true
  return tab.active
}

export function shouldShowNativeGroupBeforeTab(tab?: T.Tab, prevTab?: T.Tab): boolean {
  if (!Settings.state.nativeGroupsShowInSidebar) return false
  if (!hasNativeGroup(tab)) return false
  if (!tab) return false
  return tab.groupId !== prevTab?.groupId
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
  try {
    const group = getNativeGroup(groupId)
    const title = group?.title || firstTab.title
    Tabs.setNewTabPosition(firstTab.index, D.NOID, firstTab.panelId)

    const groupPage = await browser.tabs.create({
      active: false,
      cookieStoreId: firstTab.cookieStoreId,
      index: firstTab.index,
      url: Utils.createGroupUrl(title),
      windowId: Windows.id,
    })

    await browser.tabs.group({ tabIds: groupPage.id, groupId })
    await browser.tabs.move(groupPage.id, { index: firstTab.index }).catch(() => undefined)

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

  browser.tabs
    .update(groupPage.id, {
      url: groupPage.url.replace(D.PAGE_HASH_RE, `#${encodeURIComponent(group.title)}`),
    })
    .catch(err => Logs.warn('Tabs.syncSideberyGroupPageTitle: Cannot update group page:', err))
}

export async function toggleNativeGroupCollapsed(groupId: ID): Promise<void> {
  const group = getNativeGroup(groupId)
  if (!group) return

  await browser.tabGroups.update(groupId, { collapsed: !group.collapsed }).catch(err => {
    Logs.err('Tabs.toggleNativeGroupCollapsed: Cannot update group:', err)
  })
}

export async function renameNativeGroup(groupId: ID): Promise<void> {
  const group = getNativeGroup(groupId)
  if (!group) return

  const title = window.prompt(browser.i18n.getMessage('editBookmarkTitle') || 'Title', group.title)
  if (title === null) return

  await browser.tabGroups.update(groupId, { title: title.trim() }).catch(err => {
    Logs.err('Tabs.renameNativeGroup: Cannot rename group:', err)
  })
}

export async function ungroupNativeGroup(groupId: ID): Promise<void> {
  const tabIds = getNativeGroupTabs(groupId, true).map(tab => tab.id)
  if (!tabIds.length) return

  await browser.tabs.ungroup(tabIds).catch(err => {
    Logs.err('Tabs.ungroupNativeGroup: Cannot ungroup tabs:', err)
  })
}
