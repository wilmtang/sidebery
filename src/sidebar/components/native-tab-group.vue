<template lang="pug">
.NativeTabGroup(
  :id="'native_group' + groupId"
  :data-collapsed="group?.collapsed"
  :data-selected="selected"
  :style="{ '--native-group-color': color }"
  @contextmenu.stop="onCtxMenu"
  @mousedown.stop="onMouseDown"
  @mouseup.stop="onMouseUp"
  @dblclick.prevent.stop)
  .body
    .color-layer
    .exp
      svg.exp-icon: use(href="#icon_expand")
    .title {{title}}
    .count {{count}}
</template>

<script lang="ts" setup>
import { computed } from 'vue'
import { MenuType } from 'src/enums'
import { translate } from 'src/dict'
import * as Tabs from 'src/services/tabs.fg'
import * as Menu from 'src/services/menu.fg'
import * as Selection from 'src/services/selection.fg'
import * as Mouse from 'src/services/mouse.fg'
import * as Settings from 'src/services/settings'

const props = defineProps<{ groupId: ID }>()

const version = computed(() => Tabs.reactive.nativeGroupsVersion)
const group = computed(() => {
  version.value
  return Tabs.getNativeGroup(props.groupId)
})
const count = computed(() => {
  version.value
  return Tabs.getNativeGroupTabs(props.groupId).length
})
const title = computed(() => group.value?.title || translate('menu.tab.group'))
const selected = computed(() => Tabs.reactive.nativeGroupsSelectedId === props.groupId)
const color = computed(() => Tabs.getNativeGroupColorValue(group.value))

function onMouseDown(e: MouseEvent): void {
  Mouse.setTarget('native-group', props.groupId)
  if (Menu.isOpen) {
    Menu.close()
    return
  }
  if (e.button === 0 || e.button === 2) {
    Selection.resetSelection()
    Tabs.reactive.nativeGroupsSelectedId = props.groupId
  }
}

function onMouseUp(e: MouseEvent): void {
  const sameTarget = Mouse.isTarget('native-group', props.groupId)
  Mouse.resetTarget()
  if (Mouse.isLocked()) return Mouse.resetClickLock()

  if (e.button === 0 && sameTarget) {
    Tabs.toggleNativeGroupCollapsed(props.groupId)
  } else if (e.button === 2 && !Settings.state.ctxMenuNative) {
    Menu.open(MenuType.NativeTabGroup, e.clientX, e.clientY)
  }
}

function onCtxMenu(e: MouseEvent): void {
  if (!e.ctrlKey && !e.shiftKey) {
    Selection.resetSelection()
    Tabs.reactive.nativeGroupsSelectedId = props.groupId
  }

  if (Settings.state.ctxMenuNative) {
    browser.menus.overrideContext({ showDefaults: false })
    Menu.open(MenuType.NativeTabGroup)
  } else {
    e.preventDefault()
  }
}
</script>
