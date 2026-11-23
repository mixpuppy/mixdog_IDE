<script setup lang="ts">
import { layout } from '../layout'
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import Icon from './Icon.vue'
import TerminalView from './TerminalView.vue'
import {
  ai, MODES, activeTab, checkAvailable, refreshSessions, newSession, openSession, forkSession,
  closeTab, restartTab, starter, renameTab, cycleMode, savePrefs, ago, type AiTab, type SessionInfo
} from '../ai'
import { store, setEditorHidden } from '../store'

const views = ref<Record<string, InstanceType<typeof TerminalView>>>({})
const root = ref<HTMLElement>()

/** At this width the session list fits beside the conversation instead of replacing it. */
const SPLIT_MIN = 760
const split = computed(() => ai.wide && ai.showList && ai.tabs.length > 0)
let ro: ResizeObserver | null = null
const filter = ref('')
const editing = ref<string | null>(null)
const editText = ref('')

const current = computed(() => activeTab())
const openIds = computed(() => new Set(ai.tabs.map((t) => t.sessionId)))
const filtered = computed(() => {
  const f = filter.value.trim().toLowerCase()
  return f ? ai.sessions.filter((s) => (s.title + ' ' + s.lastPrompt).toLowerCase().includes(f)) : ai.sessions
})
const ENTRY: Record<string, string> = { 'claude-desktop': 'Claude 앱', cli: '터미널·IDE', 'sdk-cli': '스크립트' }

// Keep the list fresh while the panel is open (titles appear after the first answer).
let timer: ReturnType<typeof setInterval> | undefined
/** Width check that doesn't depend on ResizeObserver timing (it pauses while the window is hidden). */
function measure(): void {
  const w = root.value?.getBoundingClientRect().width ?? 0
  if (w > 0) ai.wide = w >= SPLIT_MIN
}
watch(
  () => [store.editorHidden, ai.width, ai.visible, layout.open.left, layout.open.right, layout.size.left, layout.size.right],
  async () => {
    await nextTick()
    measure()
  }
)

onMounted(async () => {
  ro = new ResizeObserver(([e]) => {
    if (e.contentRect.width > 0) ai.wide = e.contentRect.width >= SPLIT_MIN
  })
  ro.observe(root.value!)
  window.addEventListener('resize', measure)
  measure()
  await checkAvailable()
  refreshSessions()
  timer = setInterval(() => ai.visible && refreshSessions(), 10_000)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  ro?.disconnect()
  window.removeEventListener('resize', measure)
})
watch(() => store.project?.path, () => refreshSessions())
watch(
  () => [ai.visible, ai.active, ai.showList],
  async () => {
    if (ai.visible && ai.showList) refreshSessions()
    await nextTick()
    if (ai.visible && (!ai.showList || ai.wide) && ai.active) views.value[ai.active]?.focus()
  }
)

function select(t: AiTab): void {
  ai.active = t.termId
  if (!ai.wide) ai.showList = false
}

function toggleWide(): void {
  setEditorHidden(!store.editorHidden)
}

function toggleList(): void {
  ai.showList = !ai.showList || !ai.tabs.length
}

function startEdit(t: AiTab): void {
  if (t.exited !== null) return
  editing.value = t.termId
  editText.value = t.title
  nextTick(() => (document.querySelector('.ai .tab input') as HTMLInputElement | null)?.select())
}
function commitEdit(t: AiTab): void {
  if (editing.value !== t.termId) return
  editing.value = null
  if (editText.value.trim() && editText.value.trim() !== t.title) renameTab(t, editText.value)
}

const stale = (t: AiTab): boolean => !!store.project && t.cwd !== store.project.path
const openRow = (s: SessionInfo): void => openSession(s)

function startResize(e: MouseEvent): void {
  const startX = e.clientX
  const startW = ai.width
  const move = (ev: MouseEvent): void => {
    ai.width = Math.min(1100, Math.max(380, startW - (ev.clientX - startX)))
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
    savePrefs()
  }
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
</script>

<template>
  <aside ref="root" class="ai" :style="store.editorHidden ? undefined : { width: ai.width + 'px' }">
    <div v-if="!store.editorHidden" class="resizer" @mousedown.prevent="startResize" />

    <!-- header -->
    <div class="head">
      <span class="logo">✦</span>
      <b>Claude Code</b>
      <span class="spacer" />
      <button
        v-if="current && current.exited === null && (!ai.showList || split)"
        class="pill"
        title="권한 모드 전환 (Claude 창에서 Shift+Tab 과 같음)"
        @click="cycleMode(); views[current.termId]?.focus()"
      >
        모드 전환 <kbd>Shift+Tab</kbd>
      </button>
      <button
        class="icon-btn sm"
        :class="{ on: store.editorHidden }"
        :title="store.editorHidden ? '에디터 다시 보기 (Ctrl+Shift+M)' : 'Claude 크게 보기 - 에디터 숨기기 (Ctrl+Shift+M)'"
        @click="toggleWide"
      >
        <Icon :name="store.editorHidden ? 'collapse' : 'expand'" :size="14" />
      </button>
      <button class="icon-btn sm" :class="{ on: ai.showList && ai.tabs.length > 0 }" :title="ai.wide ? '세션 목록 (옆에 표시)' : '세션 목록'" @click="toggleList">
        <Icon name="sidebar" :size="14" />
      </button>
      <button class="icon-btn sm" title="닫기 (Ctrl+Shift+A)" @click="ai.visible = false"><Icon name="x" :size="13" /></button>
    </div>

    <!-- tabs -->
    <div v-if="ai.tabs.length" class="tabs">
      <div
        v-for="t in ai.tabs"
        :key="t.termId"
        class="tab"
        :class="{ on: t.termId === ai.active && (!ai.showList || split) }"
        :title="t.title + ' (더블클릭: 이름 바꾸기)'"
        @click="select(t)"
        @dblclick="startEdit(t)"
        @mousedown.middle.prevent="closeTab(t.termId)"
      >
        <span class="dot" :class="{ off: t.exited !== null }" />
        <input
          v-if="editing === t.termId"
          v-model="editText"
          @click.stop
          @keydown.enter="commitEdit(t)"
          @keydown.esc="editing = null"
          @blur="commitEdit(t)"
        />
        <span v-else class="ttl">{{ t.title }}</span>
        <button class="x" title="탭 닫기 (대화는 목록에 남습니다)" @click.stop="closeTab(t.termId)"><Icon name="x" :size="10" /></button>
      </div>
      <button class="newtab" title="새 세션" @click="newSession()"><Icon name="plus" :size="13" /></button>
    </div>

    <!-- CLI missing -->
    <div v-if="ai.available === false" class="center">
      <p><b>Claude Code 가 설치되어 있지 않습니다.</b></p>
      <p class="dim">Claude Code 를 설치하고 터미널에서 <code>claude</code> 를 실행해 구독 계정으로 한 번 로그인한 뒤 [다시 확인]을 누르세요.</p>
      <button class="btn" @click="checkAvailable">다시 확인</button>
    </div>

    <div v-else-if="!store.project" class="center dim">프로젝트를 먼저 열어 주세요.</div>

    <div v-else class="body" :class="{ split }">
      <!-- session list: replaces the conversation when narrow, sits beside it when wide -->
      <div v-show="ai.showList || !ai.tabs.length" class="list" :class="{ side: split }">
        <div class="start">
          <button class="primary-btn big" @click="newSession()"><Icon name="plus" :size="14" /> 새 세션</button>
          <div class="mode-pick">
            <span class="dim small">시작 모드</span>
            <select v-model="ai.startMode" class="sel" @change="savePrefs()">
              <option v-for="m in MODES" :key="m.id" :value="m.id">{{ m.label }}</option>
            </select>
            <label class="check" title="Shift+Tab 순환에 '권한 무시' 포함">
              <input v-model="ai.allowBypass" type="checkbox" @change="savePrefs()" /> 권한 무시 허용
            </label>
          </div>
        </div>

        <div class="list-head">
          <span class="section-label">{{ store.project.name }} 의 세션</span>
          <span class="spacer" />
          <input v-model="filter" class="filter" placeholder="검색" spellcheck="false" />
          <button class="icon-btn sm" title="새로고침" @click="refreshSessions()"><Icon name="refresh" :size="13" /></button>
        </div>

        <div class="rows">
          <div v-if="!filtered.length" class="empty dim small">
            {{ ai.loadingSessions ? '불러오는 중…' : filter ? '검색 결과가 없습니다' : '아직 이 프로젝트에서 나눈 대화가 없습니다' }}
          </div>
          <div v-for="s in filtered" :key="s.id" class="row" @click="openRow(s)">
            <div class="row-main">
              <div class="row-title">
                <span v-if="openIds.has(s.id)" class="live" title="탭에서 열려 있음" />
                <span class="t">{{ s.title }}</span>
              </div>
              <div class="row-sub">
                <span>{{ ago(s.updated) }}</span>
                <span>· 질문 {{ s.prompts }}개</span>
                <span v-if="ENTRY[s.entrypoint]" class="tag">{{ ENTRY[s.entrypoint] }}</span>
                <span v-if="s.lastPrompt && s.lastPrompt !== s.title" class="last">· {{ s.lastPrompt }}</span>
              </div>
            </div>
            <div class="row-actions">
              <button class="btn small" title="이 대화를 이어서 열기" @click.stop="openRow(s)">{{ openIds.has(s.id) ? '보기' : '열기' }}</button>
              <button class="btn small" title="복사본으로 분기 - 원래 대화는 그대로 두고 여기서부터 다른 방향으로" @click.stop="forkSession(s)">분기</button>
            </div>
          </div>
        </div>
        <p class="hint">탭을 닫아도 대화는 목록에 남아 언제든 다시 열 수 있습니다. 탭 이름을 더블클릭하면 이름을 바꿉니다.</p>
      </div>

      <!-- terminals: all stay mounted so background sessions keep running -->
      <div v-for="t in ai.tabs" v-show="(!ai.showList || split) && t.termId === ai.active" :key="t.termId" class="session">
        <div v-if="stale(t)" class="bar warn">이 세션은 다른 프로젝트 폴더에서 실행 중입니다: {{ t.cwd }}</div>
        <div v-if="t.exited !== null" class="bar">
          <span>Claude Code 가 종료되었습니다 (코드 {{ t.exited }})</span>
          <span class="spacer" />
          <button class="btn small primary" @click="restartTab(t)">이어서 다시 시작</button>
          <button class="btn small" @click="closeTab(t.termId)">탭 닫기</button>
        </div>
        <div class="term-wrap">
          <TerminalView
            :id="t.termId"
            :key="t.termId + ':' + t.epoch"
            :ref="(el) => { if (el) views[t.termId] = el as InstanceType<typeof TerminalView> }"
            :start="starter(t)"
            @exit="(code: number) => (t.exited = code)"
          />
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.ai {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-left: 1px solid var(--border);
  min-width: 0;
}
.resizer {
  position: absolute;
  left: -3px;
  top: 0;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 5;
}
.head {
  height: 38px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 14px;
  background: var(--chrome);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.logo {
  color: #d97757;
  font-size: 15px;
}
.spacer {
  flex: 1;
}
.icon-btn.sm {
  width: 24px;
  height: 24px;
}
.icon-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 9px;
  border-radius: 12px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-dim);
  border: 1px solid var(--border-strong);
}
.pill:hover {
  background: var(--hover);
  color: var(--text);
}
kbd {
  font-family: var(--font-ui);
  font-size: 10.5px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  padding: 0 4px;
  color: var(--text-dim);
}

/* tabs */
.tabs {
  display: flex;
  align-items: stretch;
  height: 32px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  flex-shrink: 0;
}
.tabs::-webkit-scrollbar {
  height: 0;
}
.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 10px;
  min-width: 90px;
  max-width: 200px;
  font-size: 12px;
  color: var(--text-dim);
  border-right: 1px solid var(--border);
  white-space: nowrap;
}
.tab:hover {
  background: var(--hover);
}
.tab.on {
  background: var(--surface);
  color: var(--text);
}
.tab.on::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: #d97757;
}
.tab .ttl {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab input {
  flex: 1;
  min-width: 0;
  font: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 0 4px;
  outline: none;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--green);
  flex-shrink: 0;
}
.dot.off {
  background: var(--text-faint);
}
.tab .x {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
}
.tab:hover .x,
.tab.on .x {
  opacity: 1;
}
.tab .x:hover {
  background: var(--active);
}
.newtab {
  width: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
}
.newtab:hover {
  background: var(--hover);
  color: var(--text);
}

.ai.fill {
  flex: 1;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.body.split {
  flex-direction: row;
}
.body.split .session {
  order: 0;
  min-width: 0;
}
/* list */
.list.side {
  order: 1;
  flex: 0 0 320px;
  /* long one-line titles must not widen the column (flex min-width: auto) */
  min-width: 0;
  overflow: hidden;
  border-left: 1px solid var(--border);
  background: var(--surface-2);
}
.list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.start {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-bottom: 1px solid var(--border);
}
.primary-btn.big {
  justify-content: center;
  height: 34px;
}
.mode-pick {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sel {
  height: 26px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 0 6px;
}
.check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
  margin-left: auto;
}
.list-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 10px 6px 14px;
}
.filter {
  width: 150px;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.rows {
  flex: 1;
  overflow: auto;
  padding: 0 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 8px;
}
.row:hover {
  background: var(--hover);
}
.row-main {
  flex: 1;
  min-width: 0;
}
.row-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.row-title .t {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
  flex-shrink: 0;
}
.row-sub {
  display: flex;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  margin-top: 2px;
}
.row-sub .last {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tag {
  font-size: 10.5px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--hover);
  color: var(--text-dim);
}
.row-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
}
.row:hover .row-actions {
  opacity: 1;
}
.empty {
  padding: 30px 10px;
  text-align: center;
}
.hint {
  font-size: 11.5px;
  color: var(--text-faint);
  padding: 8px 14px 12px;
  margin: 0;
  border-top: 1px solid var(--border);
}

/* sessions */
.session {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px 5px 14px;
  font-size: 12px;
  color: var(--text-dim);
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.bar.warn {
  color: #ff9f0a;
  background: rgba(255, 159, 10, 0.12);
}
.btn.small.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}
.term-wrap {
  flex: 1;
  min-height: 0;
}
.center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  line-height: 1.6;
}
.dim {
  color: var(--text-dim);
}
.small {
  font-size: 12px;
}
</style>
