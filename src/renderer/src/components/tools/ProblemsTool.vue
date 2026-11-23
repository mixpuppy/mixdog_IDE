<script setup lang="ts">
/**
 * Problems window: compiler errors / warnings of the last build or compile check, per file.
 * Click a problem to jump to it. [컴파일 검사] compiles only (fastest check).
 */
import { computed, ref } from 'vue'
import Icon from '../Icon.vue'
import FileIcon from '../FileIcon.vue'
import ToolBar from './ToolBar.vue'
import { ide, toast } from '../../ide'
import { store } from '../../store'
import { openAt } from '../../search'
import type { Problem } from '../../problems'

const showWarnings = ref(true)
const closed = ref<Record<string, boolean>>({})

const groups = computed(() => {
  const m = new Map<string, Problem[]>()
  for (const p of ide.problems) {
    if (!showWarnings.value && p.severity !== 'error') continue
    m.set(p.file, [...(m.get(p.file) ?? []), p])
  }
  // files with errors first
  return [...m.entries()]
    .map(([file, list]) => ({ file, list: list.sort((a, b) => a.line - b.line || a.col - b.col), errors: list.filter((p) => p.severity === 'error').length }))
    .sort((a, b) => b.errors - a.errors || a.file.localeCompare(b.file))
})

const errors = computed(() => ide.problems.filter((p) => p.severity === 'error').length)
const warnings = computed(() => ide.problems.length - errors.value)

const name = (f: string): string => f.split(/[\\/]/).pop() ?? f
function dir(f: string): string {
  const root = store.project?.path ?? ''
  const rel = root && f.toLowerCase().startsWith(root.toLowerCase()) ? f.slice(root.length + 1) : f
  return rel.split(/[\\/]/).slice(0, -1).join('/')
}

async function check(): Promise<void> {
  const p = store.project
  if (!p || ide.building) return
  try {
    await window.api.build.check(p.path, p.name)
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}

const first = (m: string): string => m.split('\n')[0]
</script>

<template>
  <div class="tool">
    <ToolBar>
      <button class="icon-btn" :disabled="ide.building || !store.project" title="컴파일 검사 (컴파일만 실행해 오류 확인)" @click="check">
        <Icon name="hammer" :size="14" />
      </button>
      <button class="icon-btn" :class="{ on: showWarnings }" title="경고도 보기" @click="showWarnings = !showWarnings"><Icon name="warning" :size="13" /></button>
      <span class="sum">
        <span v-if="ide.building" class="dim">컴파일 중…</span>
        <template v-else-if="ide.problems.length">
          <span class="e">오류 {{ errors }}</span>
          <span class="w">경고 {{ warnings }}</span>
        </template>
      </span>
    </ToolBar>
    <div class="body">
      <div v-if="!ide.problems.length" class="empty">
        컴파일 오류가 없습니다.<br />
        <span class="dim">빌드·실행·[컴파일 검사] 를 하면 오류가 여기와 편집기에 빨간 줄로 표시됩니다.</span>
      </div>
      <template v-for="g in groups" :key="g.file">
        <div class="frow" :title="g.file" @click="closed[g.file] = !closed[g.file]">
          <Icon :name="closed[g.file] ? 'chevronRight' : 'chevronDown'" :size="12" class="chev" />
          <FileIcon :name="name(g.file)" />
          <span class="fname">{{ name(g.file) }}</span>
          <span class="fdir">{{ dir(g.file) }}</span>
          <span class="cnt">{{ g.list.length }}</span>
        </div>
        <template v-if="!closed[g.file]">
          <div
            v-for="(p, i) in g.list"
            :key="i"
            class="prow"
            :title="p.message"
            @click="openAt(p.file, p.line, p.col)"
          >
            <span class="sev" :class="p.severity">{{ p.severity === 'error' ? '●' : '▲' }}</span>
            <span class="msg">{{ first(p.message) }}</span>
            <span class="pos">{{ p.line }}:{{ p.col }}</span>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tool {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.icon-btn:disabled {
  opacity: 0.35;
}
.icon-btn.on {
  color: #d9a400;
}
.sum {
  display: inline-flex;
  gap: 10px;
  margin-left: 6px;
  font-size: 12px;
}
.e {
  color: var(--red);
}
.w {
  color: #d9a400;
}
.dim {
  color: var(--text-dim);
}
.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 2px 0 8px;
}
.empty {
  padding: 14px;
  line-height: 1.7;
}
.frow,
.prow {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  margin: 0 6px;
  padding: 0 8px;
  border-radius: 6px;
  white-space: nowrap;
  cursor: pointer;
}
.frow:hover,
.prow:hover {
  background: var(--hover);
}
.chev {
  color: var(--text-dim);
  flex-shrink: 0;
}
.fname {
  font-weight: 600;
}
.fdir {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11.5px;
  color: var(--text-dim);
}
.cnt {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
}
.prow {
  padding-left: 40px;
  font-size: 12.5px;
}
.sev {
  flex-shrink: 0;
  font-size: 10px;
}
.sev.error {
  color: var(--red);
}
.sev.warning {
  color: #d9a400;
}
.msg {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-code);
  font-size: 12px;
}
.pos {
  flex-shrink: 0;
  margin-left: auto;
  padding-left: 10px;
  font-size: 11px;
  color: var(--text-dim);
}
</style>
