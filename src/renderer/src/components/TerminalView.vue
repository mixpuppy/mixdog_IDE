<script setup lang="ts">
/**
 * xterm.js view bound to a main-process pty. The parent starts the process
 * via `start(cols, rows)`; this component handles I/O, resize and theming.
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { bindTerminal } from '../terminals'

const props = defineProps<{ id: string; start: (cols: number, rows: number) => Promise<unknown> }>()
const emit = defineEmits<{ exit: [code: number] }>()

const host = ref<HTMLDivElement>()
let term: Terminal | null = null
let fit: FitAddon | null = null
let unbind: (() => void) | null = null
let ro: ResizeObserver | null = null

function theme(): Record<string, string> {
  const css = getComputedStyle(document.documentElement)
  const v = (n: string): string => css.getPropertyValue(n).trim()
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  return {
    background: v('--surface'),
    foreground: v('--text'),
    cursor: v('--text'),
    selectionBackground: dark ? '#3F638B99' : '#B4D8FD',
    black: dark ? '#1e1e20' : '#000000',
    brightBlack: '#6e6e73'
  }
}

defineExpose({
  focus: () => term?.focus(),
  /** (re)start the process with the current size */
  restart: async () => {
    term?.reset()
    if (fit && term) {
      fit.fit()
      await props.start(term.cols, term.rows)
    }
  }
})

onMounted(async () => {
  term = new Terminal({
    fontFamily: "'JetBrains Mono', 'D2Coding', 'Cascadia Code', Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
    theme: theme()
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host.value!)

  // Ctrl+C copies when text is selected (otherwise it is ^C); Ctrl+Shift+C/V copy/paste.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && (e.shiftKey || term!.hasSelection())) {
      navigator.clipboard.writeText(term!.getSelection())
      term!.clearSelection()
      return false
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      navigator.clipboard.readText().then((t) => window.api.pty.write(props.id, t))
      return false
    }
    return true
  })

  term.onData((d) => window.api.pty.write(props.id, d))
  term.onResize(({ cols, rows }) => window.api.pty.resize(props.id, cols, rows))
  unbind = bindTerminal(props.id, {
    data: (d) => term?.write(d),
    exit: (code) => emit('exit', code)
  })

  ro = new ResizeObserver(() => {
    if (host.value && host.value.offsetWidth > 0 && host.value.offsetHeight > 0) fit?.fit()
  })
  ro.observe(host.value!)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (term) term.options.theme = theme()
  })

  fit.fit()
  await props.start(term.cols, term.rows)
  term.focus()
})

onBeforeUnmount(() => {
  ro?.disconnect()
  unbind?.()
  term?.dispose()
})
</script>

<template>
  <div ref="host" class="term" />
</template>

<style scoped>
.term {
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--surface);
}
.term :deep(.xterm) {
  height: 100%;
  padding: 6px 0 0 10px;
}
.term :deep(.xterm-viewport) {
  background: var(--surface) !important;
}
</style>
