<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { ide } from '../ide'
import type { IdeEvent } from '../types'

const filter = ref('')
const box = ref<HTMLDivElement>()

const list = computed(() => {
  const f = filter.value.trim().toLowerCase()
  const src = f ? ide.events.filter((e) => e.type.toLowerCase().includes(f) || JSON.stringify(e.data).toLowerCase().includes(f)) : ide.events
  return src.slice(-500)
})

const time = (t: number): string => new Date(t).toLocaleTimeString('ko-KR', { hour12: false })

function summary(e: IdeEvent): string {
  const d = { ...e.data }
  for (const k of Object.keys(d)) {
    const v = d[k]
    if (typeof v === 'string' && /^[A-Z]:\\/.test(v)) d[k] = v.split('\\').slice(-2).join('\\')
  }
  return JSON.stringify(d)
}

watch(
  () => ide.events.length,
  async () => {
    await nextTick()
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  }
)
</script>

<template>
  <div class="wrap">
    <div class="top">
      <span class="note">AI 가 보게 될 IDE 활동 기록입니다. 모든 동작이 여기 이벤트로 남습니다.</span>
      <input v-model="filter" class="filter" placeholder="필터 (예: file, build, tomcat)" spellcheck="false" />
    </div>
    <div ref="box" class="list">
      <div v-for="e in list" :key="e.id" class="ev">
        <span class="t">{{ time(e.time) }}</span>
        <span class="src" :class="e.source.split(':')[0]">{{ e.source }}</span>
        <span class="type">{{ e.type }}</span>
        <span class="data">{{ summary(e) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 6px;
}
.note {
  color: var(--text-faint);
  font-size: 12px;
}
.filter {
  height: 24px;
  width: 240px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.list {
  flex: 1;
  overflow: auto;
  font-family: var(--font-code);
  font-size: 12px;
  line-height: 1.7;
  user-select: text;
}
.ev {
  display: flex;
  gap: 10px;
  white-space: nowrap;
}
.t {
  color: var(--text-faint);
}
.src {
  width: 52px;
  color: var(--text-dim);
}
.src.user {
  color: var(--accent);
}
.src.ai {
  color: #bf5af2;
}
.type {
  width: 170px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}
.data {
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
