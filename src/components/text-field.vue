<template lang="pug">
.TextField(
  :data-inactive="props.inactive"
  :data-changed="props.default !== undefined && props.default !== value"
  @mousedown="onMouseDown"
  @mouseup="onMouseUp"
  @contextmenu.stop="onContextMenu")
  .body
    .label {{translate(props.label)}}
    TextInput(
      ref="inputEl"
      :value="props.value"
      :padding="props.padding"
      :or="props.or"
      :filter="props.filter"
      :line="props.line"
      :tabindex="props.tabindex"
      :password="props.password"
      :valid="props.valid"
      :width="props.inputWidth"
      @update:value="emit('update:value', $event)"
      @keydown="emit('keydown', $event)")
  .note(v-if="autoNote") {{autoNote}}
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue'
import { translate, translateIfExists } from 'src/dict'
import type { TextInputComponent } from 'src/types'
import TextInput from './text-input.vue'

interface TextFieldProps {
  value: string | number
  valid?: string | boolean
  padding?: number
  or?: string
  filter?: (e: Event) => string
  line?: boolean
  tabindex?: string
  password?: boolean
  label?: string
  inactive?: boolean
  note?: string
  inputWidth?: string
  dbg?: string
  default?: string | number
}

const emit = defineEmits(['update:value', 'keydown'])
const props = withDefaults(defineProps<TextFieldProps>(), { padding: 0, tabindex: '0' })

const inputEl = ref<TextInputComponent | null>(null)
const autoNote = computed(() => {
  if (props.note) return props.note

  const dbgNote = translateIfExists(props.dbg ? `settings.notes.${props.dbg}` : undefined)
  if (dbgNote) return dbgNote

  return translateIfExists(`${props.label}_note`)
})

let rangeIsSelected = false

function onMouseDown(e: DOMEvent<MouseEvent>) {
  rangeIsSelected = getSelection()?.type === 'Range'
  if (e.detail > 1) e.preventDefault()
}

function onMouseUp(e: DOMEvent<MouseEvent>) {
  if (e.altKey && e.ctrlKey && e.button === 0) {
    navigator.clipboard.writeText(props.dbg ?? '')
    return
  }
  if (props.inactive || rangeIsSelected || getSelection()?.type === 'Range') return
  focus()
}

function onContextMenu(payload: PointerEvent) {
  if (props.inactive || rangeIsSelected || getSelection()?.type === 'Range') return
  payload.preventDefault()
}

function focus(): void {
  inputEl.value?.focus()
}

function error() {
  inputEl.value?.error()
}

function recalcTextHeight() {
  inputEl.value?.recalcTextHeight()
}

function selectAll() {
  inputEl.value?.selectAll()
}

defineExpose<TextInputComponent>({
  focus,
  error,
  recalcTextHeight,
  selectAll,
  getTextInput: () => inputEl.value?.getTextInput(),
})
</script>
