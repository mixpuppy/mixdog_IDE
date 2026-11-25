<script setup lang="ts">
/**
 * Build / Tomcat console. Lines come in blocks (console.ts): full blocks are skipped on
 * re-render (v-memo), so a flood of log lines only redraws the newest block, once per frame.
 * Sticks to the bottom (instantly, no smooth scroll) unless the user scrolled up.
 */
import { ref, watch, nextTick, computed } from 'vue'
import type { ConsoleBuf } from '../console'

const props = defineProps<{ buf: ConsoleBuf; empty?: string }>()
const box = ref<HTMLDivElement>()
const follow = ref(true)
// the buffer is not reactive: its tick says when to read the blocks again
const blocks = computed(() => (props.buf.state.tick, [...props.buf.blocks]))

function onScroll(): void {
  const el = box.value
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

watch(
  () => props.buf.state.tick,
  async () => {
    if (!follow.value) return
    await nextTick()
    const el = box.value
    if (el) el.scrollTop = el.scrollHeight
  }
)

function toBottom(): void {
  follow.value = true
  const el = box.value
  if (el) el.scrollTop = el.scrollHeight
}
</script>

<template>
  <div class="wrap">
    <div ref="box" class="console" @scroll.passive="onScroll">
      <div v-if="buf.state.empty" class="empty">{{ empty }}</div>
      <template v-else>
        <div v-for="b in blocks" :key="b.id" v-memo="[b.lines.length]" class="blk">
          <div v-for="l in b.lines" :key="l.id" class="ln" :class="l.cls">{{ l.text || ' ' }}</div>
        </div>
      </template>
    </div>
    <button v-if="!follow && !buf.state.empty" class="tail" title="맨 아래로 (최신 로그 따라가기)" @click="toBottom">↓ 최신</button>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  height: 100%;
}
.console {
  height: 100%;
  overflow: auto;
  font-family: var(--font-code);
  font-size: 12.5px;
  line-height: 1.55;
  user-select: text;
  cursor: text;
  overflow-anchor: none;
}
/* blocks off screen skip layout and paint */
.blk {
  content-visibility: auto;
  contain-intrinsic-size: auto 3900px;
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
.tail {
  position: absolute;
  right: 18px;
  bottom: 10px;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 12px;
  color: #fff;
  background: var(--accent);
  box-shadow: var(--shadow);
}
</style>
