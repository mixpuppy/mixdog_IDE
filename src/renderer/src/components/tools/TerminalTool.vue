<script setup lang="ts">
/** PowerShell terminal. Starts the first time it is shown, then stays alive (even when moved). */
import { ref, watch } from 'vue'
import TerminalView from '../TerminalView.vue'
import { store } from '../../store'
import { isToolVisible } from '../../layout'

const started = ref(false)
const exited = ref(false)
const view = ref<InstanceType<typeof TerminalView>>()
watch(
  () => isToolVisible('terminal'),
  (on) => {
    if (!on) return
    started.value = true
    setTimeout(() => view.value?.focus(), 60)
  },
  { immediate: true }
)
const start = (cols: number, rows: number): Promise<unknown> => {
  exited.value = false
  return window.api.pty.shell('shell', store.project?.path ?? 'C:\\', cols, rows)
}
</script>

<template>
  <div class="shell">
    <TerminalView v-if="started" id="shell" ref="view" :start="start" @exit="exited = true" />
    <button v-if="exited" class="btn restart" @click="view?.restart()">터미널 다시 시작</button>
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  height: 100%;
}
.restart {
  position: absolute;
  right: 16px;
  bottom: 12px;
}
</style>
