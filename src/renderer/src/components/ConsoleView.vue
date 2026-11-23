<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { ConsoleLine } from '../ide'

const props = defineProps<{ lines: ConsoleLine[]; empty?: string }>()
const box = ref<HTMLDivElement>()

function kind(l: ConsoleLine): string {
  const t = l.text
  if (/^\s*(▶|■)/.test(t)) return 'head'
  if (/^✔|BUILD SUCCESS|Server startup in/.test(t)) return 'ok'
  if (l.err || /\[ERROR\]|SEVERE|BUILD FAILURE|FAILED|Exception|^✖|심각/.test(t)) return 'err'
  if (/\[WARNING\]|WARN|경고/.test(t)) return 'warn'
  if (/^\s+at |^\[INFO\] -+$|^\s*$/.test(t)) return 'dim'
  return ''
}

// Stick to the bottom unless the user scrolled up.
watch(
  () => props.lines.length,
  async () => {
    const el = box.value
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    await nextTick()
    if (atBottom) el.scrollTop = el.scrollHeight
  }
)
</script>

<template>
  <div ref="box" class="console">
    <div v-if="!lines.length" class="empty">{{ empty }}</div>
    <div v-for="l in lines" :key="l.id" class="ln" :class="kind(l)">{{ l.text || ' ' }}</div>
  </div>
</template>

<style scoped>
.console {
  height: 100%;
  overflow: auto;
  font-family: var(--font-code);
  font-size: 12.5px;
  line-height: 1.55;
  user-select: text;
  cursor: text;
}
.ln {
  white-space: pre-wrap;
  word-break: break-all;
}
.ln.head {
  color: var(--accent);
  font-weight: 600;
}
.ln.ok {
  color: var(--green);
}
.ln.err {
  color: var(--red);
}
.ln.warn {
  color: #ff9f0a;
}
.ln.dim {
  color: var(--text-faint);
}
.empty {
  font-family: var(--font-ui);
  color: var(--text-faint);
}
</style>
