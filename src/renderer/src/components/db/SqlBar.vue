<script setup lang="ts">
/** Thin bar above a .sql editor: which connection it runs on, run / run all / stop. */
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import Sheet from '../Sheet.vue'
import Icon from '../Icon.vue'
import { db, loadConnections, connIdOf, setSqlConn, isConsole, runAll, runFromEditor, stopQuery, newConnection, kindLabel, txOf, setManualCommit, commitTx, rollbackTx } from '../../db'
import { editorRef, docs } from '../../monaco'
import { tabsOf } from '../../store'
import { registerSqlCompletion } from '../../dbcomplete'

/* pending statements (manual commit): count in the bar, list on click (DBeaver "pending transactions") */
interface Pending {
  sql: string
  at: number
  affected: number | null
  from: 'console' | 'grid'
}
const pendingOpen = ref(false)
const pendingList = ref<Pending[]>([])
async function showPending(): Promise<void> {
  const id = connId.value
  if (!id) return
  pendingList.value = await window.api.db.pending(id).catch(() => [])
  pendingOpen.value = true
}
const hhmmss = (t: number): string => new Date(t).toLocaleTimeString()
async function finish(commit: boolean): Promise<void> {
  const id = connId.value
  pendingOpen.value = false
  if (id) await (commit ? commitTx(id) : rollbackTx(id))
}

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

/* show the connection's commit mode (it may be saved as manual) before anything runs */
async function loadTx(id: string | null): Promise<void> {
  if (!id || db.tx[id]) return
  try {
    db.tx[id] = await window.api.db.tx(id)
  } catch {
    /* connection removed */
  }
}

onMounted(async () => {
  registerSqlCompletion()
  if (!db.loaded) await loadConnections()
  void loadTx(connIdOf(props.path))
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
const tx = computed(() => txOf(connId.value))
watch(connId, (id) => void loadTx(id))

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
    <template v-if="conn && !conn.readOnly">
      <span class="sep" />
      <button
        class="txmode"
        :class="{ on: tx.manual }"
        :title="tx.manual ? '수동 커밋: 변경은 [커밋] 을 눌러야 확정됩니다 (누르면 자동 커밋으로)' : '자동 커밋: 실행하면 바로 확정됩니다 (누르면 수동 커밋으로)'"
        @click="setManualCommit(conn.id, !tx.manual)"
      >
        {{ tx.manual ? '수동 커밋' : '자동 커밋' }}
      </button>
      <template v-if="tx.manual">
        <button class="txbtn ok" :disabled="!tx.pending || running" title="커밋 (변경 확정)" @click="commitTx(conn.id)"><Icon name="check" :size="12" />커밋</button>
        <button class="txbtn" :disabled="!tx.pending || running" title="롤백 (변경 취소)" @click="rollbackTx(conn.id)"><Icon name="undo" :size="12" />롤백</button>
      </template>
      <button v-if="tx.pending" class="pend" title="커밋 대기 중인 쿼리 보기" @click="showPending">● 커밋 대기 {{ tx.count ?? '' }}</button>
    </template>
    <span v-if="conn" class="meta">{{ kindLabel(conn.kind) }} · {{ conn.user }}@{{ conn.host }}<template v-if="conn.readOnly"> · 읽기 전용</template></span>
    <span v-if="running" class="busy">실행 중…</span>
  </div>
  <Sheet v-if="pendingOpen" :title="`커밋 대기 중인 쿼리 ${pendingList.length}개`" :width="720" @close="pendingOpen = false">
    <p class="pnote">{{ conn?.name }} · 아직 확정되지 않았습니다. [커밋] 하면 확정되고, [롤백] 하면 모두 취소됩니다.</p>
    <div class="plist">
      <div v-if="!pendingList.length" class="pnone">대기 중인 쿼리가 없습니다.</div>
      <div v-for="(p, i) in pendingList" :key="i" class="pitem">
        <div class="phead">
          <span class="pno">{{ i + 1 }}</span>
          <span class="ptime">{{ hhmmss(p.at) }}</span>
          <span class="pfrom">{{ p.from === 'grid' ? '결과 표 수정' : '콘솔' }}</span>
          <span v-if="p.affected !== null" class="paff">{{ p.affected }}행</span>
        </div>
        <pre class="psql">{{ p.sql }}</pre>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="pendingOpen = false">닫기</button>
      <button class="btn" @click="finish(false)">롤백</button>
      <button class="primary-btn" @click="finish(true)">커밋</button>
    </template>
  </Sheet>
</template>

<style scoped>
.pnote {
  margin: 2px 0 10px;
  color: var(--text-dim);
  font-size: 12.5px;
}
.plist {
  max-height: 52vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pnone {
  color: var(--text-faint);
  padding: 10px 0;
}
.pitem {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.phead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  font-size: 11.5px;
  color: var(--text-dim);
  background: var(--surface-2);
}
.pno {
  font-weight: 700;
  color: var(--text);
}
.paff {
  margin-left: auto;
  color: #d9a400;
}
.psql {
  margin: 0;
  padding: 8px 10px;
  max-height: 160px;
  overflow: auto;
  font-family: var(--font-code);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}
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
.txmode {
  height: 22px;
  padding: 0 7px;
  border-radius: 6px;
  color: var(--text-dim);
  font-size: 11.5px;
}
.txmode:hover,
.txbtn:hover:not(:disabled) {
  background: var(--hover);
}
.txmode.on {
  color: var(--accent);
  background: var(--accent-soft);
}
.txbtn {
  height: 22px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border-radius: 6px;
  font-size: 11.5px;
}
.txbtn.ok {
  color: var(--green);
}
.pend:hover {
  text-decoration: underline;
}
.pend {
  color: #d9a400;
  font-size: 11.5px;
  white-space: nowrap;
}
.busy {
  margin-left: auto;
  color: var(--accent);
}
</style>
