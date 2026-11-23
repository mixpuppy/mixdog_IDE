<script setup lang="ts">
/**
 * IntelliJ-style "Search Everywhere" (Shift twice) with tabs: 전체 / 클래스 / 파일 / 텍스트 / 동작 / 최근.
 * Fuzzy matching ("uSI" finds UserServiceImpl), "Foo.java:120" jumps to a line,
 * and the 텍스트 tab searches file contents with a preview of the lines around each match.
 */
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import FileIcon from './FileIcon.vue'
import Icon from './Icon.vue'
import { goto, fuzzy, splitLine, recentFiles, openAt, find, openFind, type GotoMode } from '../search'
import { store } from '../store'
import { run, listCommands } from '../commands'

interface Item {
  kind: 'file' | 'action' | 'text' | 'jump'
  key: string
  name: string
  /** dim second line (folder or command id) */
  sub: string
  /** characters of `name` to highlight */
  hits: number[]
  score: number
  path?: string
  cmd?: string
  /** text match position */
  line?: number
  col?: number
  len?: number
  /** text match: the matched line */
  code?: string
}

type Tab = GotoMode | 'actions' | 'text'

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'all', label: '전체', hint: 'Shift 두 번' },
  { id: 'classes', label: '클래스', hint: 'Ctrl+N' },
  { id: 'files', label: '파일', hint: 'Ctrl+Shift+N' },
  { id: 'text', label: '텍스트', hint: '코드 내용에서 찾기' },
  { id: 'actions', label: '동작', hint: 'IDE 동작 찾기' },
  { id: 'recent', label: '최근 파일', hint: 'Ctrl+E' }
]
const tab = ref<Tab>(goto.mode)
watch(() => goto.mode, (m) => (tab.value = m))

const input = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const active = ref(0)
const root = computed(() => store.project?.path ?? '')
const full = (rel: string): string => `${root.value}\\${rel.replace(/\//g, '\\')}`
const relOf = (p: string): string => (root.value && p.toLowerCase().startsWith(root.value.toLowerCase()) ? p.slice(root.value.length + 1).replace(/\\/g, '/') : p)
const CLASS_EXT = /\.(java|kt|groovy|scala)$/i

function fileItems(rels: string[], q: string, classesOnly: boolean, limit: number): Item[] {
  const out: Item[] = []
  for (const rel of rels) {
    if (classesOnly && !CLASS_EXT.test(rel)) continue
    const slash = rel.lastIndexOf('/')
    const fileName = rel.slice(slash + 1)
    const name = classesOnly ? fileName.replace(CLASS_EXT, '') : fileName
    const dir = slash >= 0 ? rel.slice(0, slash) : ''
    // "web/User" style queries match against the whole path
    const target = q.includes('/') ? rel : name
    const f = fuzzy(q, target)
    if (!f) continue
    const hits = q.includes('/') ? f.hits.map((h) => h - (slash + 1)).filter((h) => h >= 0) : f.hits
    out.push({ kind: 'file', key: 'f:' + rel, name, sub: dir, hits, score: f.score, path: full(rel) })
  }
  out.sort((a, b) => b.score - a.score || a.name.length - b.name.length)
  return out.slice(0, limit)
}

function actionItems(q: string, limit: number): Item[] {
  const out: Item[] = []
  for (const c of listCommands()) {
    const f = fuzzy(q, c.title) ?? (q ? fuzzy(q, c.id) : null)
    if (!f) continue
    out.push({ kind: 'action', key: 'a:' + c.id, name: c.title, sub: c.id, hits: fuzzy(q, c.title)?.hits ?? [], score: f.score - 50, cmd: c.id })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit)
}

const parsed = computed(() => splitLine(goto.query.trim()))

/* ---- 텍스트 tab: search file contents ---- */
interface TextHit {
  path: string
  rel: string
  line: number
  col: number
  len: number
  text: string
}
function loadOpts(): { caseSensitive: boolean; wholeWord: boolean; regex: boolean } {
  try {
    return { caseSensitive: false, wholeWord: false, regex: false, ...JSON.parse(localStorage.getItem('mixdog.gotoText') ?? '{}') }
  } catch {
    return { caseSensitive: false, wholeWord: false, regex: false }
  }
}
const textOpts = ref(loadOpts())
watch(textOpts, (o) => {
  try {
    localStorage.setItem('mixdog.gotoText', JSON.stringify(o))
  } catch {
    /* ignore */
  }
}, { deep: true })
const textHits = ref<TextHit[]>([])
const textBusy = ref(false)
const textInfo = ref('')
let textSeq = 0
let textTimer: ReturnType<typeof setTimeout> | undefined

async function runText(): Promise<void> {
  const q = goto.query.trim()
  const my = ++textSeq
  if (!store.project || q.length < 2) {
    textHits.value = []
    textInfo.value = q ? '두 글자 이상 입력하세요' : ''
    textBusy.value = false
    return
  }
  textBusy.value = true
  try {
    const r = (await window.api.search.find(store.project.path, {
      query: q, ...textOpts.value, mask: '', max: 300, channel: 'goto'
    })) as unknown as { files: { path: string; rel: string; matches: { line: number; col: number; len: number; text: string }[] }[]; total: number; truncated: boolean; ms: number; cancelled?: boolean; timedOut?: boolean }
    if (my !== textSeq || r.cancelled) return
    textHits.value = r.files.flatMap((f) => f.matches.map((m) => ({ path: f.path, rel: f.rel, ...m })))
    textInfo.value = (r.total ? `${r.files.length}개 파일 · ${r.total}${r.truncated ? '+' : ''}개` : '결과 없음') + (r.timedOut ? ' (일부만 검색)' : '')
  } catch (e) {
    if (my === textSeq) textInfo.value = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
  } finally {
    if (my === textSeq) textBusy.value = false
  }
}
watch([() => goto.query, tab, textOpts], () => {
  if (tab.value !== 'text') return
  clearTimeout(textTimer)
  textBusy.value = goto.query.trim().length >= 2
  textTimer = setTimeout(runText, 220)
}, { deep: true, immediate: true })

/** the selected text hit's surrounding lines (preview pane) */
const fileCache = new Map<string, string[]>()
const preview = ref<{ rel: string; start: number; lines: string[]; line: number; col: number; len: number } | null>(null)
async function loadPreview(h: Item | undefined): Promise<void> {
  if (!h || h.kind !== 'text' || !h.path || !h.line) {
    preview.value = null
    return
  }
  let lines = fileCache.get(h.path)
  if (!lines) {
    try {
      lines = (await window.api.fs.readFile(h.path)).split(/\r?\n/)
      fileCache.set(h.path, lines)
    } catch {
      preview.value = null
      return
    }
  }
  const start = Math.max(1, h.line - 3)
  const raw = lines.slice(start - 1, h.line + 3).map((l) => l.replace(/\t/g, '    '))
  // drop the indentation all preview lines share, so deeply nested code stays visible
  const indent = Math.min(...raw.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length))
  const cut = Number.isFinite(indent) ? indent : 0
  const tabsBefore = (lines[h.line - 1] ?? '').slice(0, (h.col ?? 1) - 1).split('\t').length - 1
  preview.value = {
    rel: h.sub,
    start,
    lines: raw.map((l) => l.slice(cut)),
    line: h.line,
    // match column in the de-indented, tab-expanded line
    col: (h.col ?? 1) + tabsBefore * 3 - cut,
    len: h.len ?? 0
  }
}

/** send the query to the search window (Ctrl+Enter) for replace / longer result lists */
function toFindWindow(): void {
  find.caseSensitive = textOpts.value.caseSensitive
  find.wholeWord = textOpts.value.wholeWord
  find.regex = textOpts.value.regex
  const q = goto.query.trim()
  close()
  openFind(false, q)
}

const items = computed<Item[]>(() => {
  const q = parsed.value.q
  const t = tab.value
  if (t === 'recent' || (t === 'all' && !q)) {
    const rec = recentFiles().filter((p) => p.toLowerCase() !== store.activePath?.toLowerCase())
    const rels = rec.map(relOf)
    if (!q) return rels.slice(0, 30).map((rel, i) => ({ kind: 'file', key: 'r:' + rel, name: rel.slice(rel.lastIndexOf('/') + 1), sub: rel.slice(0, Math.max(0, rel.lastIndexOf('/'))), hits: [], score: -i, path: rec[i] }))
    return fileItems(rels, q, false, 30)
  }
  if (t === 'text') {
    return textHits.value.slice(0, 300).map((h, i) => ({
      kind: 'text', key: `t:${h.rel}:${h.line}:${h.col}:${i}`, name: `${h.rel.slice(h.rel.lastIndexOf('/') + 1)}:${h.line}`,
      sub: h.rel, hits: [], score: -i, path: h.path, line: h.line, col: h.col, len: h.len, code: h.text
    }))
  }
  if (t === 'actions') return actionItems(q, 40)
  if (t === 'classes') return fileItems(goto.files, q, true, 60)
  if (t === 'files') return fileItems(goto.files, q, false, 60)
  // 전체: classes first (Java people search classes), then other files, then actions
  const files = fileItems(goto.files, q, false, 40)
  const acts = actionItems(q, 6).filter((a) => a.score > 200)
  // offer a code search when the name search finds little
  const jump: Item[] = q.length >= 2 && files.length < 5 ? [{ kind: 'jump', key: 'jump', name: `코드에서 '${q}' 찾기`, sub: '텍스트 탭', hits: [], score: 0 }] : []
  return [...files, ...acts, ...jump]
})

watch([items, tab], () => {
  active.value = 0
  nextTick(() => listEl.value?.scrollTo({ top: 0 }))
})
watch([active, items], () => loadPreview(items.value[active.value]))

function pick(i: number): void {
  const it = items.value[i]
  if (!it) return
  if (it.kind === 'jump') {
    tab.value = 'text'
    return
  }
  close()
  if (it.kind === 'action' && it.cmd) run(it.cmd)
  else if (it.kind === 'text' && it.path) openAt(it.path, it.line, it.col, it.len)
  else if (it.path) openAt(it.path, parsed.value.line, parsed.value.col)
}

function close(): void {
  goto.open = false
}

function onKey(e: KeyboardEvent): void {
  const n = items.value.length
  if (e.key === 'Escape') close()
  else if (e.key === 'ArrowDown') active.value = n ? (active.value + 1) % n : 0
  else if (e.key === 'ArrowUp') active.value = n ? (active.value - 1 + n) % n : 0
  else if (e.key === 'Enter' && e.ctrlKey && tab.value === 'text') toFindWindow()
  else if (e.key === 'Enter') pick(active.value)
  else if (e.key === 'Tab') {
    const i = TABS.findIndex((t) => t.id === tab.value)
    tab.value = TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].id
  } else return
  e.preventDefault()
  nextTick(() => listEl.value?.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' }))
}

/** a matched code line around the hit (leading spaces trimmed) */
function codeParts(it: Item): { pre: string; hit: string; post: string } {
  const t = it.code ?? ''
  const s0 = (it.col ?? 1) - 1
  const lead = Math.min(t.length - t.trimStart().length, s0)
  return { pre: t.slice(lead, s0), hit: t.slice(s0, s0 + (it.len ?? 0)), post: t.slice(s0 + (it.len ?? 0), s0 + (it.len ?? 0) + 160) }
}

/** split a name into plain / highlighted pieces */
function parts(name: string, hits: number[]): { t: string; h: boolean }[] {
  const set = new Set(hits)
  const out: { t: string; h: boolean }[] = []
  for (let i = 0; i < name.length; i++) {
    const h = set.has(i)
    if (out.length && out[out.length - 1].h === h) out[out.length - 1].t += name[i]
    else out.push({ t: name[i], h })
  }
  return out
}

const away = (e: MouseEvent): void => {
  if (!(e.target as HTMLElement).closest('.goto')) close()
}
onMounted(() => {
  input.value?.focus()
  input.value?.select()
  window.addEventListener('mousedown', away, true)
})
onBeforeUnmount(() => window.removeEventListener('mousedown', away, true))
</script>

<template>
  <div class="goto" @keydown="onKey">
    <div class="tabs">
      <button v-for="t in TABS" :key="t.id" class="tab" :class="{ on: tab === t.id }" :title="t.hint" @mousedown.prevent="tab = t.id">{{ t.label }}</button>
      <span class="tip">Tab 으로 전환 · 파일:줄 번호 로 바로 이동</span>
    </div>
    <div class="search">
      <Icon name="search" :size="15" />
      <input
        ref="input"
        v-model="goto.query"
        spellcheck="false"
        :placeholder="tab === 'actions' ? '동작 이름' : tab === 'classes' ? '클래스 이름 (대문자 약어 가능: uSI → UserServiceImpl)' : tab === 'text' ? '코드 내용 (예: selectUserList, 파일 업로드)' : '파일 · 클래스 · 동작 이름'"
      />
      <span v-if="goto.loading || (tab === 'text' && textBusy)" class="spin" />
      <template v-if="tab === 'text'">
        <span class="tinfo">{{ textBusy ? '' : textInfo }}</span>
        <button class="opt" :class="{ on: textOpts.caseSensitive }" title="대소문자 구분" @mousedown.prevent="textOpts.caseSensitive = !textOpts.caseSensitive">Aa</button>
        <button class="opt" :class="{ on: textOpts.wholeWord }" title="단어 단위" @mousedown.prevent="textOpts.wholeWord = !textOpts.wholeWord"><u>ab</u></button>
        <button class="opt" :class="{ on: textOpts.regex }" title="정규식" @mousedown.prevent="textOpts.regex = !textOpts.regex">.*</button>
      </template>
    </div>
    <div ref="listEl" class="list" :class="{ withPreview: tab === 'text' && preview }">
      <div
        v-for="(it, i) in items"
        :key="it.key"
        class="it"
        :class="{ on: i === active }"
        @mousemove="active = i"
        @mousedown.prevent="pick(i)"
      >
        <template v-if="it.kind === 'text'">
          <FileIcon :name="it.path ?? it.name" />
          <span class="code"><span>{{ codeParts(it).pre }}</span><mark>{{ codeParts(it).hit }}</mark><span>{{ codeParts(it).post }}</span></span>
          <span class="where">{{ it.name }}</span>
        </template>
        <template v-else>
          <FileIcon v-if="it.kind === 'file'" :name="it.path ?? it.name" />
          <Icon v-else :name="it.kind === 'jump' ? 'search' : 'settings'" :size="14" class="act-ico" />
          <span class="name"><span v-for="(p, k) in parts(it.name, it.hits)" :key="k" :class="{ hl: p.h }">{{ p.t }}</span></span>
          <span class="sub">{{ it.sub }}</span>
          <span v-if="it.kind === 'action'" class="badge">동작</span>
        </template>
      </div>
      <div v-if="!items.length && !goto.loading && !(tab === 'text' && (textBusy || goto.query.trim().length < 2))" class="none">
        {{ store.project ? '일치하는 항목이 없습니다' : '프로젝트를 먼저 여세요' }}
      </div>
      <div v-if="tab === 'text' && goto.query.trim().length < 2 && !items.length" class="none">코드 내용을 두 글자 이상 입력하세요</div>
    </div>
    <div v-if="tab === 'text' && preview" class="preview">
      <div class="ptitle">{{ preview.rel }}</div>
      <div v-for="(l, k) in preview.lines" :key="k" class="pl" :class="{ cur: preview.start + k === preview.line }">
        <span class="pn">{{ preview.start + k }}</span>
        <span v-if="preview.start + k === preview.line" class="pc">{{ l.slice(0, preview.col - 1) }}<mark>{{ l.slice(preview.col - 1, preview.col - 1 + preview.len) }}</mark>{{ l.slice(preview.col - 1 + preview.len) }}</span>
        <span v-else class="pc">{{ l || ' ' }}</span>
      </div>
    </div>
    <div v-if="tab === 'text'" class="foot">Enter 열기 · Ctrl+Enter 검색 창으로 보내기 (바꾸기·전체 결과)</div>
  </div>
</template>

<style scoped>
.goto {
  position: fixed;
  z-index: 260;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  width: min(720px, calc(100vw - 40px));
  max-height: min(560px, calc(100vh - 100px));
  display: flex;
  flex-direction: column;
  background: var(--elevated);
  border-radius: 12px;
  box-shadow: var(--shadow), 0 20px 60px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 8px 10px 0;
}
.tab {
  height: 26px;
  padding: 0 11px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--text-dim);
}
.tab:hover {
  background: var(--hover);
}
.tab.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
}
.tip {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-faint);
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 10px;
  padding: 0 10px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  color: var(--text-faint);
}
.search input {
  flex: 1;
  border: none;
  outline: none;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 14px;
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 6px 8px;
}
.it {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  border-radius: 7px;
  white-space: nowrap;
}
.it.on {
  background: var(--accent);
  color: #fff;
}
.name {
  flex-shrink: 0;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hl {
  font-weight: 800;
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.it.on .hl {
  color: #fff;
}
.sub {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--text-faint);
  direction: rtl;
  text-align: left;
}
.it.on .sub {
  color: rgba(255, 255, 255, 0.75);
}
.badge {
  font-size: 10.5px;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--hover);
}
.act-ico {
  color: var(--text-dim);
}
.tinfo {
  font-size: 11.5px;
  color: var(--text-faint);
  white-space: nowrap;
}
.opt {
  height: 22px;
  min-width: 26px;
  padding: 0 4px;
  border-radius: 5px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-faint);
  font-family: var(--font-code);
}
.opt:hover {
  background: var(--hover);
}
.opt.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-code);
  font-size: 12.5px;
}
.where {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--text-faint);
}
.it.on .where {
  color: rgba(255, 255, 255, 0.8);
}
mark {
  background: #ffd60a66;
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.it.on mark {
  background: rgba(255, 255, 255, 0.35);
}
.list.withPreview {
  max-height: 250px;
  flex: none;
}
.preview {
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  background: var(--surface);
  padding: 4px 0 6px;
  font-family: var(--font-code);
  font-size: 12.5px;
  line-height: 19px;
  overflow: hidden;
}
.ptitle {
  padding: 2px 12px 4px;
  font-family: var(--font-ui);
  font-size: 11.5px;
  color: var(--text-faint);
}
.pl {
  display: flex;
  gap: 10px;
  padding: 0 12px;
  white-space: pre;
}
.pl.cur {
  background: var(--accent-soft);
}
.pn {
  width: 38px;
  flex-shrink: 0;
  text-align: right;
  color: var(--text-faint);
  font-size: 11.5px;
}
.pc {
  overflow: hidden;
  text-overflow: ellipsis;
}
.foot {
  flex-shrink: 0;
  padding: 5px 12px;
  font-size: 11px;
  color: var(--text-faint);
  border-top: 1px solid var(--border);
}
.none {
  padding: 18px;
  text-align: center;
  color: var(--text-faint);
}
.spin {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid var(--accent-soft);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
