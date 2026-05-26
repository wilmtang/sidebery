<template lang="pug">
section(ref="el")
  h2 {{translate('settings.group_title')}}
  span.header-shadow
  SelectField(
    label="settings.group_layout"
    optLabel="settings.group_layout_"
    v-model:value="Settings.state.groupLayout"
    dbg="groupLayout"
    :default="DEFAULT_SETTINGS.groupLayout"
    :opts="Settings.getOpts('groupLayout')"
    @update:value="Settings.saveDebounced(150)")
  .sub-title: .text {{translate('settings.native_groups_title')}}
  ToggleField(
    label="settings.native_groups_show_in_sidebar"
    v-model:value="Settings.state.nativeGroupsShowInSidebar"
    dbg="nativeGroupsShowInSidebar"
    :default="DEFAULT_SETTINGS.nativeGroupsShowInSidebar"
    @update:value="Settings.saveDebounced(150)")
  ToggleField(
    label="settings.native_groups_show_colored_rails"
    v-model:value="Settings.state.nativeGroupsShowColoredRails"
    dbg="nativeGroupsShowColoredRails"
    :default="DEFAULT_SETTINGS.nativeGroupsShowColoredRails"
    :inactive="!Settings.state.nativeGroupsShowInSidebar"
    @update:value="Settings.saveDebounced(150)")
  ToggleField(
    label="settings.native_groups_create_sidebery_page"
    v-model:value="Settings.state.nativeGroupsCreateSideberyPage"
    dbg="nativeGroupsCreateSideberyPage"
    :default="DEFAULT_SETTINGS.nativeGroupsCreateSideberyPage"
    @update:value="Settings.saveDebounced(150)")
</template>

<script lang="ts" setup>
import { ref, onMounted } from 'vue'
import { translate } from 'src/dict'
import { DEFAULT_SETTINGS } from 'src/defaults'
import * as Settings from 'src/services/settings.fg'
import * as SetupPage from 'src/services/setup-page.fg'
import SelectField from '../../components/select-field.vue'
import ToggleField from '../../components/toggle-field.vue'

const el = ref<HTMLElement | null>(null)

onMounted(() => SetupPage.registerEl('settings_group', el.value))
</script>
