<script setup lang="ts">
/** Running background tasks (status bar popup), each with its own dog progress bar. */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import DogProgress from './DogProgress.vue'
import { tasks, elapsed } from '../tasks'

const now = ref(Date.now())
const el = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

const away = (e: MouseEvent): void => {
  if (!el.value?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-tasks-trigger]')) tasks.open = false
}
const esc = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') tasks.open = false
}
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 1000)
  window.addEventListener('mousedown', away, true)
  window.addEventListener('keydown', esc)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  window.removeEventListener('mousedown', away, true)
  window.removeEventListener('keydown', esc)
})
</script>

<template>
  <div ref="el" class="tl">
    <div class="head">진행 중인 작업 <span class="n">{{ tasks.list.length }}</span></div>
    <div v-if="!tasks.list.length" class="none">진행 중인 작업이 없습니다 🐾</div>
    <div v-for="t in tasks.list" :key="t.id" class="task">
      <div class="top">
        <b class="title">{{ t.title }}</b>
        <span v-if="t.source" class="src">{{ t.source }}</span>
        <span class="time">{{ elapsed(t, now) }}</span>
        <button v-if="t.cancel" class="x" title="취소" @click="t.cancel()">✕</button>
      </div>
      <div class="bar">
        <DogProgress :pct="t.pct" :width="300" />
        <span class="pct">{{ t.pct === null ? '' : t.pct + '%' }}</span>
      </div>
      <div class="detail" :title="t.detail">{{ t.detail || ' ' }}</div>
    </div>
  </div>
</template>

<style scoped>
.tl {
  position: fixed;
  right: 10px;
  bottom: calc(var(--statusbar-h) + 6px);
  z-index: 240;
  width: 380px;
  max-height: 60vh;
  overflow: auto;
  padding: 6px 6px 8px;
  background: var(--elevated);
  border-radius: 10px;
  box-shadow: var(--shadow);
}
.head {
  padding: 6px 8px 8px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-dim);
}
.n {
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
}
.none {
  padding: 14px 8px;
  color: var(--text-faint);
}
.task {
  padding: 8px 8px 6px;
  border-radius: 8px;
}
.task + .task {
  border-top: 1px solid var(--border);
}
.top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.title {
  font-size: 12.5px;
}
.src {
  font-size: 10.5px;
  font-weight: 700;
  padding: 0 6px;
  border-radius: 8px;
  background: #d97757;
  color: #fff;
}
.time {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.x {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: var(--text-faint);
  font-size: 11px;
}
.x:hover {
  background: var(--red);
  color: #fff;
}
.bar {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.pct {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  margin-bottom: 1px;
}
.detail {
  margin-top: 3px;
  font-size: 11px;
  font-family: var(--font-code);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
