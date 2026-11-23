<script setup lang="ts">
/** Thin bar above a .sql editor: which connection it runs on, run / run all / stop. */
import { computed, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../Icon.vue'
import { db, loadConnections, connIdOf, setSqlConn, isConsole, runAll, runFromEditor, stopQuery, newConnection, kindLabel } from '../../db'
import { editorRef, docs } from '../../monaco'
import { tabsOf } from '../../store'

const props = defineProps<{ path: string }>()

/** consoles are scratch files: saved automatically (IntelliJ does the same), no "unsaved" prompts */
let saveTimer: ReturnType<typeof setTimeout> | undefined
let sub: { dispose(): void } | undefined
function autosave(): void {
  const doc = docs.get(props.path)
  if (!doc || !isConsole(props.path)) return
  const version = doc.model.getAlternativeVersionId()
  void window.api.fs.writeFile(props.path, doc.model.getValue()).then(() => {
    doc.savedVersion = version
    if (doc.model.getAlternativeVersionId() === version) for (const t of tabsOf(props.path)) t.dirty = false
  })
}

onMounted(async () => {
  if (!db.loaded) await loadConnections()
  if (!isConsole(props.path)) return
  sub = docs.get(props.path)?.model.onDidChangeContent(() => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(autosave, 800)
  })
})
onBeforeUnmount(() => {
  sub?.dispose()
  if (saveTimer) {
    clearTimeout(saveTimer)
    autosave()
  }
})

const connId = computed(() => connIdOf(props.path))
const conn = computed(() => db.conns.find((c) => c.id === connId.value))
const running = computed(() => !!db.results[props.path]?.running)
const fixed = computed(() => isConsole(props.path))

function pick(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  if (v === '__new') {
    newConnection()
    return
  }
  setSqlConn(props.path, v || null)
}

async function runCurrent(): Promise<void> {
  const ed = editorRef.current
  if (!ed) return
  await runFromEditor(ed, props.path)
}
</script>

<template>
  <div class="sqlbar">
    <button class="run" :disabled="!conn || running" title="실행 (Ctrl+Enter) · 커서의 문장 또는 선택 영역" @click="runCurrent">
      <Icon name="play" :size="13" />
    </button>
    <button class="icon-btn" :disabled="!conn || running" title="전체 실행" @click="runAll(path)">
      <Icon name="follow" :size="13" />
    </button>
    <button class="icon-btn stop" :disabled="!running" title="중지" @click="stopQuery(path)"><Icon name="stop" :size="12" /></button>
    <span class="sep" />
    <Icon name="database" :size="13" class="dbi" :class="{ on: conn?.connected }" />
    <span v-if="fixed" class="name">{{ conn ? `${conn.name}` : '연결이 삭제됨' }}</span>
    <select v-else class="pick" :value="connId ?? ''" @change="pick">
      <option value="">DB 선택…</option>
      <option v-for="c in db.conns" :key="c.id" :value="c.id">{{ c.name }} ({{ kindLabel(c.kind) }})</option>
      <option value="__new">+ 새 연결…</option>
    </select>
    <span v-if="conn" class="meta">{{ kindLabel(conn.kind) }} · {{ conn.user }}@{{ conn.host }}<template v-if="conn.readOnly"> · 읽기 전용</template></span>
    <span v-if="running" class="busy">실행 중…</span>
  </div>
</template>

<style scoped>
.sqlbar {
  height: 30px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 12px;
}
.run {
  width: 24px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--green);
}
.run:hover:not(:disabled) {
  background: var(--hover);
}
.icon-btn {
  width: 24px;
  height: 22px;
}
button:disabled {
  opacity: 0.35;
}
.stop {
  color: var(--red);
}
.sep {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border-strong);
}
.dbi {
  color: var(--text-dim);
}
.dbi.on {
  color: var(--green);
}
.name {
  font-weight: 600;
}
.pick {
  height: 22px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  padding: 0 4px;
  max-width: 260px;
}
.meta {
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.busy {
  margin-left: auto;
  color: var(--accent);
}
</style>
