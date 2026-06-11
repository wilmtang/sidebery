<template lang="pug">
.Dialog.popup-container(@click="answer(null)")
  .focus-stealer(
    v-if="dialog.buttonsDefaultFocus"
    tabindex="0"
    ref="focusStealer"
    @keydown.prevent.stop="onKBKey"
    @focus="onFocus"
    @blur="onBlur")
  .popup(@click.stop)
    h2 {{dialog.title}}
    .note(v-if="dialog.note") {{dialog.note}}
    TextInput.input(
      v-if="dialog.input"
      ref="inputEl"
      :value="inputValue"
      :or="dialog.input.placeholder"
      :line="true"
      :tabindex="'-1'"
      @update:value="onInputUpdate"
      @keydown="onInputKD")
    ToggleField(
      v-if="dialog.checkbox"
      :label="dialog.checkbox.label"
      v-model:value="dialog.checkbox.value"
      @update:value="dialog.checkbox?.update")
    .ctrls(:data-centered="dialog.buttonsCentered" :data-inline="dialog.buttonsInline")
      .btn.-wrap(
        v-for="(btn, i) of dialog.buttons"
        :class="{ '-warn': btn.warn, '-wide': !dialog.buttonsInline, '-focused': focusedBtnIndex === i }"
        @click="answer(btn.value)") {{btn.label}}
</template>

<script lang="ts" setup>
import { onMounted, ref } from 'vue'
import type { Dialog, TextInputComponent } from 'src/types'
import ToggleField from 'src/components/toggle-field.vue'
import TextInput from 'src/components/text-input.vue'

const props = defineProps<{ dialog: Dialog }>()
const focusedBtnIndex = ref(-1)
let prevFocusedBtnIndex = -1
const focusStealer = ref<HTMLElement | null>(null)
const inputEl = ref<TextInputComponent | null>(null)
const inputValue = ref(props.dialog.input?.value ?? '')

onMounted(() => {
  if (props.dialog.input && inputEl.value) {
    inputEl.value.focus()
    inputEl.value.selectAll()
  } else if (document.hasFocus() && focusStealer.value) {
    focusStealer.value.focus()
  }
})

function onInputUpdate(value: string): void {
  inputValue.value = value
  props.dialog.input?.update(value)
}

function onInputKD(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    const defaultValue = props.dialog.buttonsDefaultFocus
    const btn =
      (defaultValue && props.dialog.buttons.find(b => b.value === defaultValue)) ||
      props.dialog.buttons[0]
    if (btn) answer(btn.value)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    answer(null)
  }
}

function initFocusedBtn() {
  if (!document.hasFocus()) return
  if (props.dialog.buttonsDefaultFocus === undefined) return

  if (prevFocusedBtnIndex === -1) {
    const defaultValue = props.dialog.buttonsDefaultFocus
    const index = props.dialog.buttons.findIndex(b => b.value === defaultValue)
    if (index !== -1) focusedBtnIndex.value = index
  } else {
    focusedBtnIndex.value = prevFocusedBtnIndex
  }
}

function onKBKey(e: KeyboardEvent) {
  // Select next button
  if (e.code === 'ArrowRight' || (e.code === 'Tab' && !e.shiftKey) || e.code === 'KeyL') {
    const index = focusedBtnIndex.value
    const btn = props.dialog.buttons[index]
    if (!btn) return

    const nextButton = props.dialog.buttons[index + 1]
    if (nextButton) focusedBtnIndex.value = index + 1
  }

  // Select prev button
  else if (e.code === 'ArrowLeft' || (e.code === 'Tab' && e.shiftKey) || e.code === 'KeyH') {
    const index = focusedBtnIndex.value
    const btn = props.dialog.buttons[index]
    if (!btn) return

    const nextButton = props.dialog.buttons[index - 1]
    if (nextButton) focusedBtnIndex.value = index - 1
  }

  // Enter
  else if (e.code === 'Enter') {
    const index = focusedBtnIndex.value
    const btn = props.dialog.buttons[index]
    if (!btn) return

    answer(btn.value)
  }
}

function onFocus() {
  initFocusedBtn()
}

function onBlur() {
  prevFocusedBtnIndex = focusedBtnIndex.value
  focusedBtnIndex.value = -1
}

function answer(value: string | null): void {
  if (!props.dialog) return
  props.dialog.result(value)
}
</script>
