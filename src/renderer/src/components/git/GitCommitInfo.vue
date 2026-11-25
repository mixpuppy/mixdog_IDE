<script setup lang="ts">
/** Right panel for a selected commit: message, author, parents, changed files. */
import { computed, ref } from 'vue'
import GitFileList from './GitFileList.vue'
import { git, select, openCommitDiff, refsAt, newBranch, checkout, cherryPick, revert } from '../../git'
import { toast } from '../../ide'

const d = computed(() => git.detail)
const refs = computed(() => (d.value ? refsAt(d.value.hash) : []))

/* draggable line between the commit message and the changed files (height remembered; double click = auto) */
const KEY = 'mixdog.commitInfoH'
const root = ref<HTMLElement | null>(null)
const metaH = ref<number | null>(((): number | null => {
  try {
    const v = Number(localStorage.getItem(KEY))
    return v > 0 ? v : null
  } catch {
    return null
  }
})())
const metaStyle = computed(() => (metaH.value ? { height: `${metaH.value}px` } : {}))
function drag(e: MouseEvent): void {
  const box = root.value?.getBoundingClientRect()
  const meta = root.value?.querySelector<HTMLElement>('.meta')
  if (!box || !meta) return
  const startY = e.clientY
  const startH = meta.getBoundingClientRect().height
  const move = (ev: MouseEvent): void => {
    // keep at least a few lines of each part
    metaH.value = Math.round(Math.min(box.height - 90, Math.max(70, startH + ev.clientY - startY)))
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
    try {
      localStorage.setItem(KEY, String(metaH.value ?? ''))
    } catch {
      /* ignore */
    }
  }
  document.body.style.cursor = 'row-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
function resetSplit(): void {
  metaH.value = null
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

function copy(text: string): void {
  navigator.clipboard.writeText(text).then(() => toast('복사됨', 'ok'))
}
</script>

<template>
  <div v-if="!d" class="loading">불러오는 중…</div>
  <div v-else ref="root" class="info">
    <div class="meta" :class="{ fixed: metaH }" :style="metaStyle">
      <div class="subject">{{ d.subject }}</div>
      <pre v-if="d.body" class="body">{{ d.body }}</pre>
      <div v-if="refs.length" class="refs">
        <span v-for="r in refs" :key="r.ref" class="ref">{{ r.name }}</span>
      </div>
      <div class="kv">
        <span class="k">작성자</span><span>{{ d.author }} &lt;{{ d.email }}&gt;</span>
        <span class="k">날짜</span><span>{{ new Date(d.time).toLocaleString() }}</span>
        <template v-if="d.committer !== d.author"><span class="k">커미터</span><span>{{ d.committer }}</span></template>
        <span class="k">커밋</span><span class="mono link" title="복사" @click="copy(d.hash)">{{ d.hash.slice(0, 12) }}</span>
        <span class="k">부모</span>
        <span>
          <span v-for="p in d.parents" :key="p" class="mono link parent" @click="select(p)">{{ p.slice(0, 7) }}</span>
          <span v-if="!d.parents.length" class="dim">(최초 커밋)</span>
        </span>
      </div>
      <div class="actions">
        <button class="btn small" @click="newBranch(d.hash)">여기서 브랜치</button>
        <button class="btn small" @click="checkout(d.hash)">체크아웃</button>
        <button class="btn small" @click="cherryPick(d.hash)">체리픽</button>
        <button class="btn small" @click="revert(d.hash)">Revert</button>
      </div>
    </div>
    <div class="split" title="드래그해서 크기 조절 · 더블클릭하면 원래대로" @mousedown.prevent="drag" @dblclick="resetSplit" />
    <div class="files">
    <div class="sec-head">
      변경된 파일 {{ d.files.length }}
      <span v-if="d.parents.length > 1" class="dim"> · 첫 번째 부모 기준</span>
    </div>
    <div class="scroll">
      <GitFileList :files="d.files" letter="x" :active-path="git.diff?.path" @open="openCommitDiff(d, $event)" @menu="() => {}" />
    </div>
    </div>
  </div>
</template>

<style scoped>
.loading {
  padding: 20px;
  color: var(--text-faint);
}
.info {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.meta {
  flex-shrink: 0;
  /* until the user drags the line: as tall as the message, at most about half the panel */
  max-height: 55%;
  overflow: auto;
  padding: 12px 14px;
  user-select: text;
}
.meta.fixed {
  max-height: none;
}
.split {
  flex-shrink: 0;
  height: 7px;
  margin: -3px 0;
  position: relative;
  z-index: 2;
  cursor: row-resize;
}
.split::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 3px;
  height: 1px;
  background: var(--border);
}
.split:hover::after {
  height: 2px;
  top: 2.5px;
  background: var(--accent);
}
.files {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.subject {
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.45;
  word-break: break-word;
}
.body {
  margin: 8px 0 0;
  font: 12.5px/1.55 var(--font-ui);
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}
.refs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}
.ref {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--accent-soft);
  color: var(--accent);
}
.kv {
  display: grid;
  grid-template-columns: 46px 1fr;
  gap: 4px 8px;
  margin-top: 10px;
  font-size: 12px;
  word-break: break-all;
}
.k {
  color: var(--text-faint);
}
.mono {
  font-family: var(--font-code);
  font-size: 11.5px;
}
.link {
  color: var(--accent);
  cursor: pointer;
}
.parent {
  margin-right: 8px;
}
.dim {
  color: var(--text-faint);
  font-weight: 400;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 12px;
}
.sec-head {
  height: 30px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-dim);
}
.scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
