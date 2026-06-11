<template lang="pug">
.TabsPanel(
  @wheel="onWheel"
  @contextmenu.stop="onNavCtxMenu"
  @mousedown="onMouseDown"
  @mouseup.right="onRightMouseUp"
  @mouseleave="onMouseLeave"
  @dblclick="onDoubleClick"
  @drop="onDrop")
  PinnedTabsBar(v-if="panel.reactive.pinnedTabIds.length" :panel="panel")
  ScrollBox(ref="scrollBox" :preScroll="D.PRE_SCROLL")
    DragAndDropPointer(:panelId="panel.id" :subPanel="false")
    AnimatedTabList(:panel="panel")
      template(v-for="item in visibleItems" :key="item.key")
        NativeTabGroup(v-if="item.type === 'group'" :groupId="item.id")
        TabComponent(v-else :tabId="item.id" :guide="item.guide")
      NewTabBar(
        v-if="Settings.state.showNewTabBtns && Settings.state.newTabBarPosition === 'after_tabs'"
        :panel="panel")
      .tab-space-filler(:style="{ '--filler-height': `${panel.reactive.scrollRetainerHeight}px` }")
      .bottom-space(:key="-9999999")

  NewTabBar(
    v-if="Settings.state.showNewTabBtns && Settings.state.newTabBarPosition === 'bottom'"
    :panel="panel")

  .bottom-bar-space(v-if="bottomBarSpaceNeeded")

  PanelPlaceholder(
    :isMsg="Search.reactive.active && panel.reactive.filteredLen === 0"
    :msg="translate('panel.nothing_found')")
</template>

<script lang="ts" setup>
import { computed, ref, onMounted } from 'vue'
import { translate } from 'src/dict'
import type { ScrollBoxComponent, Tab, TabsPanel } from 'src/types'
import * as E from 'src/enums'
import * as D from 'src/defaults'
import * as Settings from 'src/services/settings'
import * as Selection from 'src/services/selection.fg'
import * as Menu from 'src/services/menu.fg'
import * as Sidebar from 'src/services/sidebar.fg'
import * as Tabs from 'src/services/tabs.fg'
import * as Mouse from 'src/services/mouse.fg'
import * as DnD from 'src/services/drag-and-drop.fg'
import * as Search from 'src/services/search.fg'
import PinnedTabsBar from './bar.pinned-tabs.vue'
import ScrollBox from 'src/components/scroll-box.vue'
import TabComponent from './tab.vue'
import NativeTabGroup from './native-tab-group.vue'
import PanelPlaceholder from './panel-placeholder.vue'
import NewTabBar from './bar.new-tab.vue'
import DragAndDropPointer from './dnd-pointer.vue'
import AnimatedTabList from './animated-tab-list.vue'

const props = defineProps<{ panel: TabsPanel }>()
const scrollBox = ref<ScrollBoxComponent | null>(null)
const bottomBarSpaceNeeded =
  Settings.state.subPanelRecentlyClosedBar ||
  Settings.state.subPanelBookmarks ||
  Settings.state.subPanelHistory
let scrollBoxEl: HTMLElement | null = null

type TreeGuideSlot = {
  lvl: number
  color: string
  continues: boolean
}
type NativeGroupThread = {
  color: string
  collapsed: boolean
  start: boolean
  middle: boolean
  end: boolean
}
export type TabGuideInfo = {
  slots: TreeGuideSlot[]
  connectorColor: string
  nativeGroupThread?: NativeGroupThread
}
type VisibleItem =
  | { type: 'tab'; id: ID; key: string; guide: TabGuideInfo }
  | { type: 'group'; id: ID; key: string }

// Precomputed, per-recompute lookups shared across all tab guides. Built in a
// single linear pass so rendering stays O(n·depth) instead of O(n²) with large
// tab counts (see audit N17).
type GroupRailCtx = {
  visibleIndexByTabId: Map<ID, number>
  ancestorsByTabId: Map<ID, Tab[]>
  ancestorLastVisibleIndex: Map<ID, number>
  visualGroupIdByTabId: Map<ID, ID | undefined>
  groupFirstVisibleIndex: Map<ID, number>
  groupLastVisibleIndex: Map<ID, number>
}

const visibleItems = computed<VisibleItem[]>(() => {
  Tabs.reactive.nativeGroupsVersion
  const items: VisibleItem[] = []
  let prevTab: Tab | undefined

  const tabs = props.panel.reactive.visibleTabIds
    .map(id => Tabs.byId[id])
    .filter((tab): tab is Tab => !!tab)

  // Cache the visual native group id for every tab (walks ancestors once each).
  const visualGroupIdByTabId = new Map<ID, ID | undefined>()
  for (const tab of tabs) {
    visualGroupIdByTabId.set(tab.id, Tabs.getVisualNativeGroupId(tab))
  }

  // Single linear pass over the visible subset to derive everything the tree /
  // native-group guides need: visible index, ancestor chain, the last visible
  // index at which each ancestor has a descendant, and the first/last visible
  // index of each native group.
  const visibleIndexByTabId = new Map<ID, number>()
  const ancestorsByTabId = new Map<ID, Tab[]>()
  const ancestorLastVisibleIndex = new Map<ID, number>()
  const groupFirstVisibleIndex = new Map<ID, number>()
  const groupLastVisibleIndex = new Map<ID, number>()
  let visibleIndex = 0
  for (const tab of tabs) {
    if (!Tabs.isTabVisibleInNativeGroup(tab)) continue

    const index = visibleIndex++
    visibleIndexByTabId.set(tab.id, index)

    const ancestors = getAncestors(tab)
    ancestorsByTabId.set(tab.id, ancestors)
    for (const ancestor of ancestors) ancestorLastVisibleIndex.set(ancestor.id, index)

    const groupId = visualGroupIdByTabId.get(tab.id)
    if (groupId !== undefined) {
      if (!groupFirstVisibleIndex.has(groupId)) groupFirstVisibleIndex.set(groupId, index)
      groupLastVisibleIndex.set(groupId, index)
    }
  }

  const ctx: GroupRailCtx = {
    visibleIndexByTabId,
    ancestorsByTabId,
    ancestorLastVisibleIndex,
    visualGroupIdByTabId,
    groupFirstVisibleIndex,
    groupLastVisibleIndex,
  }

  const groupHeaderCounts = new Map<ID, number>()
  for (const tab of tabs) {
    const groupId = visualGroupIdByTabId.get(tab.id)
    const prevGroupId = prevTab ? visualGroupIdByTabId.get(prevTab.id) : undefined
    if (
      Settings.state.nativeGroupsShowInSidebar &&
      groupId !== undefined &&
      groupId !== prevGroupId
    ) {
      // Suffix the key with an occurrence index so a visual group whose tabs
      // become non-contiguous can't emit two headers with the same Vue key (L6).
      const occ = groupHeaderCounts.get(groupId) ?? 0
      groupHeaderCounts.set(groupId, occ + 1)
      items.push({ type: 'group', id: groupId, key: `g:${groupId}:${occ}` })
    }

    if (visibleIndexByTabId.has(tab.id)) {
      items.push({ type: 'tab', id: tab.id, key: `t:${tab.id}`, guide: getTabGuide(tab, ctx) })
    }

    prevTab = tab
  }

  return items
})

function getTabGuide(tab: Tab, ctx: GroupRailCtx): TabGuideInfo {
  const ancestors = ctx.ancestorsByTabId.get(tab.id) ?? []
  const parent = ancestors[ancestors.length - 1]
  const index = ctx.visibleIndexByTabId.get(tab.id) ?? -1

  return {
    slots: ancestors.map(ancestor => ({
      lvl: ancestor.lvl,
      color: getTreeGuideColor(ancestor),
      continues: (ctx.ancestorLastVisibleIndex.get(ancestor.id) ?? -1) > index,
    })),
    connectorColor: parent ? getTreeGuideColor(parent) : '',
    nativeGroupThread: getNativeGroupThread(tab, ctx),
  }
}

function getNativeGroupThread(tab: Tab, ctx: GroupRailCtx): NativeGroupThread | undefined {
  if (!Settings.state.nativeGroupsShowInSidebar || !Settings.state.nativeGroupsShowColoredRails) {
    return
  }

  const nativeGroupId = ctx.visualGroupIdByTabId.get(tab.id)
  if (nativeGroupId === undefined) return
  const nativeGroup = Tabs.getNativeGroup(nativeGroupId)
  if (!nativeGroup) return

  const index = ctx.visibleIndexByTabId.get(tab.id)
  if (index === undefined) return

  const start = ctx.groupFirstVisibleIndex.get(nativeGroupId) === index
  const end = ctx.groupLastVisibleIndex.get(nativeGroupId) === index

  return {
    color: Tabs.getNativeGroupColorValue(nativeGroup),
    collapsed: nativeGroup.collapsed,
    start,
    middle: !start && !end,
    end,
  }
}

function getAncestors(tab: Tab): Tab[] {
  const ancestors: Tab[] = []
  const seen = new Set<ID>()
  let parent = Tabs.byId[tab.parentId]

  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id)
    ancestors.unshift(parent)
    parent = Tabs.byId[parent.parentId]
  }

  return ancestors
}

function getTreeGuideColor(tab: Tab): string {
  if (Settings.state.colorizeTabsBranches && tab.reactive.branchColor) {
    return tab.reactive.branchColor
  }

  return ''
}

onMounted(() => {
  if (scrollBox.value) {
    Sidebar.setPanelScrollBox(props.panel.id, scrollBox.value)
    scrollBoxEl = scrollBox.value.getScrollBox()
    if (scrollBoxEl) Sidebar.setPanelEls(props.panel.id, { scrollBox: scrollBoxEl })
  }
})

function onDrop(): void {
  DnD.reactive.dstType = E.DropType.Tabs
}

function onMouseDown(e: MouseEvent): void {
  Mouse.setTarget('panel', props.panel.id)
  if ((e.target as HTMLElement).draggable) return
  if (Selection.isSet()) return

  if (e.button === 0) {
    if (Menu.isOpen) {
      Menu.close()
      return
    }

    const la = Settings.state.tabsPanelLeftClickAction
    if (la === 'prev') return Sidebar.switchPanel(-1)
    if (la === 'expand') {
      if (!Settings.state.tabsTree) return
      let targetTab = Tabs.list.find(t => t.active)
      if (!targetTab) return
      if (!targetTab.isParent) targetTab = Tabs.byId[targetTab.parentId]
      if (!targetTab) return
      return Tabs.toggleBranch(targetTab.id)
    }
    if (la === 'tab') {
      Tabs.createTabInPanel(props.panel, { position: Settings.state.tabsPanelLeftClickTabPos })
      return
    }
    if (la === 'parent') {
      if (!Settings.state.tabsTree) return
      const activeTab = Tabs.list.find(t => t.active)
      if (!activeTab || !Tabs.byId[activeTab.parentId]) return
      browser.tabs.update(activeTab.parentId, { active: true })
    }
  }

  if (e.button === 1) {
    e.preventDefault()
    const ma = Settings.state.tabsPanelMiddleClickAction
    if (ma === 'tab') {
      Tabs.createTabInPanel(props.panel, { position: Settings.state.tabsPanelMiddleClickTabPos })
    }
    if (ma === 'undo') Tabs.undoRmTab()
    if (ma === 'rm_act_tab') {
      let actTab = Tabs.byId[Tabs.activeId]
      if (actTab && actTab.panelId === props.panel.id && !actTab.pinned) {
        Tabs.removeTabs([Tabs.activeId])
      }
    }
  }

  if (e.button === 2) {
    Menu.blockCtxMenu()
    const ra = Settings.state.tabsPanelRightClickAction
    if (ra === 'next') return Sidebar.switchPanel(1)
    if (ra === 'expand') {
      if (!Settings.state.tabsTree) return
      let targetTab = Tabs.list.find(t => t.active)
      if (!targetTab) return
      if (!targetTab.isParent) targetTab = Tabs.byId[targetTab.parentId]
      if (!targetTab) return
      return Tabs.toggleBranch(targetTab.id)
    }
    if (ra === 'parent') {
      if (!Settings.state.tabsTree) return
      const activeTab = Tabs.list.find(t => t.active)
      if (!activeTab || !Tabs.byId[activeTab.parentId]) return
      browser.tabs.update(activeTab.parentId, { active: true })
    }
  }
}

function onRightMouseUp(e: MouseEvent): void {
  if (Mouse.isTarget('tab.close')) return
  Mouse.resetTarget()

  if (Mouse.isLocked()) return Mouse.resetClickLock()
  if (Settings.state.tabsPanelRightClickAction !== 'menu') return
  if (Selection.isSet()) return
  e.stopPropagation()

  if (Settings.state.ctxMenuNative) return

  Selection.selectNavItem(props.panel.id)
  Menu.open(E.MenuType.TabsPanel, e.clientX, e.clientY)
}

function onNavCtxMenu(e: MouseEvent): void {
  const sameTarget = Mouse.isCtxTarget('panel', props.panel.id)
  Mouse.resetCtxTarget()
  if (!sameTarget) {
    e.stopPropagation()
    e.preventDefault()
    return
  }

  if (
    Mouse.isLocked() ||
    !Settings.state.ctxMenuNative ||
    e.ctrlKey ||
    e.shiftKey ||
    Selection.isSet()
  ) {
    Mouse.resetClickLock()
    e.stopPropagation()
    e.preventDefault()
    return
  }

  let nativeCtx = { showDefaults: false }
  browser.menus.overrideContext(nativeCtx)

  if (!Selection.isSet()) Selection.selectNavItem(props.panel.id)
  Menu.open(E.MenuType.TabsPanel)
}

function onDoubleClick(e: MouseEvent) {
  if (!Mouse.isTarget('panel', props.panel.id)) return
  if (Settings.state.tabsPanelLeftClickAction !== 'none') return
  const da = Settings.state.tabsPanelDoubleClickAction
  if (da === 'tab') {
    Tabs.createTabInPanel(props.panel, { position: Settings.state.tabsPanelDoubleClickTabPos })
  } else if (da === 'collapse') {
    const topLvlTabs = props.panel.tabs.filter(t => t.lvl === 0)
    if (topLvlTabs.length) Tabs.foldAllInactiveBranches(topLvlTabs)
  } else if (da === 'undo') {
    Tabs.undoRmTab()
  }
}

const onWheel = Mouse.getWheelDebouncer(E.WheelDirection.Vertical, (e: WheelEvent) => {
  if (e.deltaY !== 0 && Tabs.blockedScrollPosition) Tabs.resetScrollRetainer(props.panel)
  if (Sidebar.scrollAreaRightX && e.clientX > Sidebar.scrollAreaRightX) return
  if (Sidebar.scrollAreaLeftX && e.clientX < Sidebar.scrollAreaLeftX) return

  const stt = Settings.state.scrollThroughTabs
  const presel = stt === 'psp' || stt === 'psg'
  const glob = stt === 'global' || stt === 'psg'

  if (!presel && Selection.isSet()) return
  if (stt !== 'none') {
    if (scrollBoxEl && Settings.state.scrollThroughTabsExceptOverflow) {
      if (scrollBoxEl.scrollHeight > scrollBoxEl.offsetHeight) return
    }

    e.preventDefault()

    const globaly = glob !== e.shiftKey
    const cyclic = Settings.state.scrollThroughTabsCyclic !== e.ctrlKey

    if (e.deltaY !== 0) Mouse.blockWheel(E.WheelDirection.Horizontal)

    const globPin = Settings.state.scrollThroughTabsGlobPinIsolate ? false : undefined
    if (presel) {
      if (e.deltaY > 0) Tabs.switchTab(globaly, cyclic, 1, globPin, true)
      else if (e.deltaY < 0) Tabs.switchTab(globaly, cyclic, -1, globPin, true)
    } else {
      if (e.deltaY > 0) Tabs.switchTab(globaly, cyclic, 1, globPin)
      else if (e.deltaY < 0) Tabs.switchTab(globaly, cyclic, -1, globPin)
    }
  }
})

function onMouseLeave() {
  if (Tabs.blockedScrollPosition) Tabs.resetScrollRetainer(props.panel)
}
</script>
