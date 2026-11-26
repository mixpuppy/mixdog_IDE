<script setup lang="ts">
/**
 * IntelliJ-style 3-way conflict resolver: 내 쪽 | 결과 | 가져오는 쪽.
 * Changes made on one side only (or on different lines) are merged automatically; each real
 * conflict gets buttons: 내 것 / 상대 것 / 둘 다 / 기준. The result stays editable.
 */
import { ref, computed, shallowRef, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { monaco, currentTheme, languageOf, resetEditorServices } from '../../monaco'
import type { editor } from 'monaco-editor'
import { conflictUi, closeResolver } from '../../conflicts'
import { merge3, splitLines, type Block } from '../../merge3'
import { store } from '../../store'
import { refresh as refreshGit } from '../../git'
import { toast } from '../../ide'
import { confirmSheet } from '../../ui'

interface Versions {
  path: string
  base: string | null
  ours: string | null
  theirs: string | null
  binary: boolean
  oursLabel: string
  theirsLabel: string
}
interface Conflict {
  deco: string
  base: string[]
  ours: string[]
  theirs: string[]
  oursStart: number
  theirsStart: number
  resolved: boolean
  /** no lines in the result (a point) */
  empty: boolean
}

const P = (): string => store.project!.path
const file = computed(() => conflictUi.files[conflictUi.index])
const v = ref<Versions | null>(null)
const error = ref('')
const busy = ref(false)
const conflicts = ref<Conflict[]>([])
const cur = ref(0)
const autoCount = ref(0)
const left = ref<HTMLElement>()
const mid = ref<HTMLElement>()
const right = ref<HTMLElement>()
const edL = shallowRef<editor.IStandaloneCodeEditor | null>(null)
const edM = shallowRef<editor.IStandaloneCodeEditor | null>(null)
const edR = shallowRef<editor.IStandaloneCodeEditor | null>(null)
let models: editor.ITextModel[] = []
let eol = '\n'
let finalNewline = true
const simple = computed(() => !!v.value && (v.value.binary || v.value.ours === null || v.value.theirs === null))
const unresolved = computed(() => conflicts.value.filter((c) => !c.resolved).length)
const allDone = computed(() => conflictUi.files.every((f) => conflictUi.done[f]))

const opts = (readOnly: boolean): editor.IStandaloneEditorConstructionOptions => ({
  theme: currentTheme(),
  readOnly,
  automaticLayout: true,
  minimap: { enabled: false },
  fontFamily: "'JetBrains Mono', 'D2Coding', Consolas, monospace",
  fontSize: 12.5,
  lineHeight: 19,
  scrollBeyondLastLine: false,
  renderLineHighlight: 'none',
  glyphMargin: false,
  folding: false,
  lineNumbersMinChars: 3
})

function disposeEditors(): void {
  for (const e of [edL.value, edM.value, edR.value]) e?.dispose()
  edL.value = edM.value = edR.value = null
  for (const m of models) m.dispose()
  models = []
  resetEditorServices()
}

/** whole lines start0 (0-based) .. +len for side panes */
const lineRange = (start0: number, len: number): monaco.IRange => ({ startLineNumber: start0 + 1, startColumn: 1, endLineNumber: start0 + Math.max(len, 1), endColumn: 1 })

/**
 * A conflict's place in the result model: lines start1 (1-based) .. +len. An empty one (len 0)
 * is a point: "insert before line start1" (or after the last line).
 */
function rangeFor(m: editor.ITextModel, start1: number, len: number): monaco.IRange {
  const count = m.getLineCount()
  if (len > 0) {
    const end = Math.min(start1 + len - 1, count)
    return { startLineNumber: start1, startColumn: 1, endLineNumber: end, endColumn: m.getLineMaxColumn(end) }
  }
  if (start1 <= count) return { startLineNumber: start1, startColumn: 1, endLineNumber: start1, endColumn: 1 }
  return { startLineNumber: count, startColumn: m.getLineMaxColumn(count), endLineNumber: count, endColumn: m.getLineMaxColumn(count) }
}

async function load(): Promise<void> {
  error.value = ''
  disposeEditors()
  conflicts.value = []
  v.value = null
  if (!file.value) return
  try {
    v.value = (await window.api.conflicts.versions(P(), file.value)) as unknown as Versions
  } catch (e) {
    error.value = (e as Error).message
    return
  }
  if (simple.value) return
  const o = splitLines(v.value.ours ?? '')
  const t = splitLines(v.value.theirs ?? '')
  const b = splitLines(v.value.base ?? '')
  eol = o.eol
  finalNewline = o.finalNewline
  const blocks: Block[] = merge3(b.lines, o.lines, t.lines)
  // result text: merged blocks, conflicts start with the base text (like IntelliJ)
  const out: string[] = []
  const conflictAt: { start: number; len: number; block: Extract<Block, { kind: 'conflict' }> }[] = []
  const autoMarks: { result: [number, number]; ours: [number, number]; theirs: [number, number]; side: string }[] = []
  let auto = 0
  for (const bl of blocks) {
    if (bl.kind === 'same') out.push(...bl.lines)
    else if (bl.kind === 'auto') {
      auto++
      autoMarks.push({ result: [out.length, bl.lines.length], ours: [bl.ours.start, bl.ours.len], theirs: [bl.theirs.start, bl.theirs.len], side: bl.side })
      out.push(...bl.lines)
    } else {
      conflictAt.push({ start: out.length, len: bl.baseLines.length, block: bl })
      out.push(...bl.baseLines)
    }
  }
  autoCount.value = auto
  await nextTick()
  const lang = languageOf(file.value)
  const mo = monaco.editor.createModel(o.lines.join('\n'), lang)
  const mt = monaco.editor.createModel(t.lines.join('\n'), lang)
  const mr = monaco.editor.createModel(out.join('\n'), lang)
  models = [mo, mt, mr]
  edL.value = monaco.editor.create(left.value!, { ...opts(true), model: mo })
  edM.value = monaco.editor.create(mid.value!, { ...opts(false), model: mr })
  edR.value = monaco.editor.create(right.value!, { ...opts(true), model: mt })
  resetEditorServices()
  // side panes: what each side changed
  const sideDeco = (m: editor.ITextModel, ranges: { r: [number, number]; cls: string }[]): void => {
    m.deltaDecorations(
      [],
      ranges.filter((x) => x.r[1] > 0).map((x) => ({ range: lineRange(x.r[0], x.r[1]), options: { isWholeLine: true, className: x.cls } }))
    )
  }
  sideDeco(mo, [
    ...autoMarks.filter((a) => a.side !== 'theirs').map((a) => ({ r: a.ours, cls: 'cr-auto' })),
    ...conflictAt.map((c) => ({ r: [c.block.ours.start, c.block.ours.len] as [number, number], cls: 'cr-conflict' }))
  ])
  sideDeco(mt, [
    ...autoMarks.filter((a) => a.side !== 'ours').map((a) => ({ r: a.theirs, cls: 'cr-auto' })),
    ...conflictAt.map((c) => ({ r: [c.block.theirs.start, c.block.theirs.len] as [number, number], cls: 'cr-conflict' }))
  ])
  mr.deltaDecorations(
    [],
    autoMarks.filter((a) => a.result[1] > 0).map((a) => ({ range: lineRange(a.result[0], a.result[1]), options: { isWholeLine: true, className: 'cr-auto' } }))
  )
  conflicts.value = conflictAt.map((c) => ({
    deco: mr.deltaDecorations([], [{ range: rangeFor(mr, c.start + 1, c.len), options: conflictDeco(false, c.len) }])[0],
    empty: c.len === 0,
    base: c.block.baseLines,
    ours: c.block.oursLines,
    theirs: c.block.theirsLines,
    oursStart: c.block.ours.start,
    theirsStart: c.block.theirs.start,
    resolved: false
  }))
  cur.value = 0
  if (conflicts.value.length) reveal(0)
}

function conflictDeco(resolved: boolean, len: number): editor.IModelDecorationOptions {
  return {
    isWholeLine: true,
    className: resolved ? 'cr-resolved' : len ? 'cr-conflict' : undefined,
    linesDecorationsClassName: resolved ? 'cr-mark-ok' : 'cr-mark',
    stickiness: 1
  }
}

/** current place of a conflict in the result: first line (1-based) and line count */
function placeOf(c: Conflict): { start: number; len: number } {
  const m = models[2]
  const r = m.getDecorationRange(c.deco)
  if (!r) return { start: 1, len: 0 }
  if (c.empty) {
    // a point at the end of a line means "after that line"
    const atEnd = r.startColumn > 1 && r.startColumn === m.getLineMaxColumn(r.startLineNumber)
    return { start: r.startLineNumber + (atEnd ? 1 : 0), len: 0 }
  }
  return { start: r.startLineNumber, len: r.endLineNumber - r.startLineNumber + 1 }
}

function setPlace(c: Conflict, start: number, len: number, resolved: boolean): void {
  const m = models[2]
  m.deltaDecorations([c.deco], [])
  c.deco = m.deltaDecorations([], [{ range: rangeFor(m, start, len), options: conflictDeco(resolved, len) }])[0]
  c.empty = len === 0
  c.resolved = resolved
}

function replace(c: Conflict, lines: string[]): void {
  const m = models[2]
  const { start, len } = placeOf(c)
  const count = m.getLineCount()
  const edit = (range: monaco.IRange, text: string): void => {
    edM.value!.executeEdits('conflict', [{ range, text, forceMoveMarkers: true }])
  }
  if (len > 0 && lines.length) {
    const end = start + len - 1
    edit({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: m.getLineMaxColumn(end) }, lines.join('\n'))
    setPlace(c, start, lines.length, true)
  } else if (len > 0) {
    // remove the lines (and their line break)
    const end = start + len - 1
    if (end < count) {
      edit({ startLineNumber: start, startColumn: 1, endLineNumber: end + 1, endColumn: 1 }, '')
      setPlace(c, start, 0, true)
    } else if (start > 1) {
      edit({ startLineNumber: start - 1, startColumn: m.getLineMaxColumn(start - 1), endLineNumber: end, endColumn: m.getLineMaxColumn(end) }, '')
      setPlace(c, start, 0, true)
    } else {
      edit(m.getFullModelRange(), '')
      setPlace(c, 1, 0, true)
    }
  } else if (lines.length) {
    const emptyModel = count === 1 && m.getLineContent(1) === ''
    if (emptyModel) {
      edit({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, lines.join('\n'))
      setPlace(c, 1, lines.length, true)
    } else if (start <= count) {
      edit({ startLineNumber: start, startColumn: 1, endLineNumber: start, endColumn: 1 }, lines.join('\n') + '\n')
      setPlace(c, start, lines.length, true)
    } else {
      const mc = m.getLineMaxColumn(count)
      edit({ startLineNumber: count, startColumn: mc, endLineNumber: count, endColumn: mc }, '\n' + lines.join('\n'))
      setPlace(c, count + 1, lines.length, true)
    }
  } else {
    setPlace(c, start, 0, true)
  }
}

function choose(kind: 'ours' | 'theirs' | 'oursTheirs' | 'theirsOurs' | 'base', i = cur.value): void {
  const c = conflicts.value[i]
  if (!c) return
  const lines = kind === 'ours' ? c.ours : kind === 'theirs' ? c.theirs : kind === 'oursTheirs' ? [...c.ours, ...c.theirs] : kind === 'theirsOurs' ? [...c.theirs, ...c.ours] : c.base
  replace(c, lines)
  conflicts.value = [...conflicts.value]
  const next = conflicts.value.findIndex((x, j) => j > i && !x.resolved)
  if (next >= 0) reveal(next)
}

function chooseAll(kind: 'ours' | 'theirs'): void {
  conflicts.value.forEach((c, i) => {
    if (!c.resolved) choose(kind, i)
  })
}

function markResolved(): void {
  const c = conflicts.value[cur.value]
  if (!c) return
  const p = placeOf(c)
  setPlace(c, p.start, p.len, true)
  conflicts.value = [...conflicts.value]
}

function reveal(i: number): void {
  cur.value = i
  const c = conflicts.value[i]
  if (!c || !edM.value) return
  const p = placeOf(c)
  edM.value.revealLineInCenter(Math.max(1, p.start))
  edL.value?.revealLineInCenter(c.oursStart + 1)
  edR.value?.revealLineInCenter(c.theirsStart + 1)
}

async function save(): Promise<void> {
  if (!file.value || !v.value) return
  if (unresolved.value && !(await confirmSheet('해결하지 않은 충돌', `아직 고르지 않은 충돌이 ${unresolved.value}개 있습니다. 결과 창의 지금 내용(기준 내용) 그대로 저장할까요?`, '그대로 저장'))) return
  const text = models[2].getLinesContent().join(eol) + (finalNewline ? eol : '')
  await commitFile(text)
}

/** binary / added-deleted conflicts: take one side as a whole */
async function takeWhole(side: 'ours' | 'theirs' | 'delete'): Promise<void> {
  if (!v.value) return
  const text = side === 'delete' ? null : side === 'ours' ? v.value.ours : v.value.theirs
  if (v.value.binary && text !== null) {
    // binary: let git check out that side (content can't round-trip as text)
    try {
      await window.api.git.checkoutSide(P(), v.value.path, side as 'ours' | 'theirs')
      await afterSave()
    } catch (e) {
      error.value = (e as Error).message
    }
    return
  }
  await commitFile(text)
}

async function commitFile(text: string | null): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await window.api.conflicts.resolve(P(), file.value!, text)
    await afterSave()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

async function afterSave(): Promise<void> {
  conflictUi.done[file.value!] = true
  toast(`${file.value} 해결`, 'ok')
  void refreshGit()
  const next = conflictUi.files.findIndex((f) => !conflictUi.done[f])
  if (next >= 0) conflictUi.index = next
  else disposeEditors()
}

async function finish(push: boolean): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const hash = await window.api.conflicts.finish(P())
    toast(`병합 커밋 ${String(hash).slice(0, 7)}`, 'ok')
    if (push) {
      await window.api.git.push(P(), false)
      toast(conflictUi.mr ? `MR !${conflictUi.mr.iid} 충돌을 해결해 Push 했습니다` : 'Push 완료', 'ok')
    }
    await refreshGit()
    closeResolver()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

watch(file, () => void load())
onMounted(() => void load())
onBeforeUnmount(disposeEditors)

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeResolver()
}
</script>

<template>
  <div class="cr-overlay" @keydown="onKey">
    <div class="cr">
      <div class="head">
        <b>충돌 해결</b>
        <span v-if="conflictUi.mr" class="dim">MR !{{ conflictUi.mr.iid }} · {{ conflictUi.mr.target }} → {{ conflictUi.mr.source }} 에 병합 중</span>
        <span class="grow" />
        <button class="btn small" @click="closeResolver">닫기 (Esc)</button>
      </div>
      <div class="body">
        <!-- files -->
        <div v-if="conflictUi.files.length > 1" class="files">
          <div
            v-for="(f, i) in conflictUi.files"
            :key="f"
            class="file"
            :class="{ on: i === conflictUi.index, done: conflictUi.done[f] }"
            :title="f"
            @click="conflictUi.index = i"
          >
            <span class="st">{{ conflictUi.done[f] ? '✓' : '●' }}</span>{{ f.split('/').pop() }}
          </div>
        </div>
        <div class="main">
          <template v-if="allDone">
            <div class="alldone">
              <p><b>모든 충돌을 해결했습니다.</b></p>
              <p class="dim">해결한 파일은 스테이지돼 있습니다. 병합 커밋을 만들면 마무리됩니다{{ conflictUi.mr ? ' (Push 하면 GitLab MR 의 충돌도 사라집니다)' : '' }}.</p>
              <div class="row">
                <button class="btn" :disabled="busy" @click="finish(false)">병합 커밋만</button>
                <button class="primary-btn" :disabled="busy" @click="finish(true)">{{ busy ? '처리 중…' : '병합 커밋하고 Push' }}</button>
              </div>
            </div>
          </template>
          <template v-else-if="v && simple">
            <div class="alldone">
              <p><b>{{ v.path }}</b></p>
              <p class="dim">
                {{ v.binary ? '바이너리 파일이라 줄 단위로 합칠 수 없습니다.' : v.ours === null ? '내 쪽에서는 지워졌고 가져오는 쪽에서는 고쳐졌습니다.' : '가져오는 쪽에서는 지워졌고 내 쪽에서는 고쳐졌습니다.' }}
                어느 쪽을 쓸지 고르세요.
              </p>
              <div class="row">
                <button class="btn" :disabled="busy || (v.ours === null && !v.binary)" @click="takeWhole('ours')">{{ v.oursLabel }} 사용</button>
                <button class="btn" :disabled="busy || (v.theirs === null && !v.binary)" @click="takeWhole('theirs')">{{ v.theirsLabel }} 사용</button>
                <button class="btn" :disabled="busy" @click="takeWhole('delete')">파일 삭제</button>
              </div>
            </div>
          </template>
          <template v-else-if="v">
            <div class="bar">
              <span class="fname">{{ v.path }}</span>
              <span class="stat">
                <template v-if="conflicts.length">충돌 {{ conflicts.length - unresolved }}/{{ conflicts.length }} 해결</template>
                <template v-else>충돌 없음</template>
                · 자동으로 합친 변경 {{ autoCount }}개
              </span>
              <span class="grow" />
              <template v-if="conflicts.length">
                <button class="btn small" :disabled="cur <= 0" @click="reveal(cur - 1)">◀ 이전</button>
                <span class="pos">{{ cur + 1 }} / {{ conflicts.length }}</span>
                <button class="btn small" :disabled="cur >= conflicts.length - 1" @click="reveal(cur + 1)">다음 ▶</button>
              </template>
            </div>
            <div v-if="conflicts.length" class="bar actions">
              <span class="dim">이 충돌:</span>
              <button class="btn small" title="왼쪽(내 쪽) 내용 사용" @click="choose('ours')">◀ 내 것</button>
              <button class="btn small" title="오른쪽(가져오는 쪽) 내용 사용" @click="choose('theirs')">상대 것 ▶</button>
              <button class="btn small" @click="choose('oursTheirs')">둘 다 (내 것 먼저)</button>
              <button class="btn small" @click="choose('theirsOurs')">둘 다 (상대 것 먼저)</button>
              <button class="btn small" title="양쪽 변경 전 원래 내용" @click="choose('base')">기준으로</button>
              <button class="btn small" title="결과 창에서 직접 고친 내용으로 해결 처리" @click="markResolved">직접 고친 대로</button>
              <span class="grow" />
              <span class="dim">남은 것 모두:</span>
              <button class="btn small" @click="chooseAll('ours')">내 것</button>
              <button class="btn small" @click="chooseAll('theirs')">상대 것</button>
            </div>
            <div class="labels">
              <span>{{ v.oursLabel }}</span>
              <span>결과 (직접 고칠 수 있음)</span>
              <span>{{ v.theirsLabel }}</span>
            </div>
            <div class="eds">
              <div ref="left" class="ed" />
              <div ref="mid" class="ed mid" />
              <div ref="right" class="ed" />
            </div>
            <div class="foot">
              <span class="legend"><i class="sw auto" /> 자동으로 합침 <i class="sw conflict" /> 충돌 <i class="sw ok" /> 해결함</span>
              <span class="grow" />
              <button class="primary-btn" :disabled="busy" @click="save">{{ busy ? '저장 중…' : '이 파일 해결 (저장·스테이지)' }}</button>
            </div>
          </template>
          <div v-else-if="!error" class="alldone dim">불러오는 중…</div>
          <div v-if="error" class="error">{{ error }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cr-overlay {
  position: fixed;
  inset: 0;
  z-index: 250;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
}
.cr {
  width: calc(100vw - 48px);
  height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface);
  box-shadow: var(--shadow);
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 12px 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.dim {
  color: var(--text-dim);
  font-size: 12px;
}
.grow {
  flex: 1;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.files {
  width: 200px;
  flex-shrink: 0;
  overflow: auto;
  border-right: 1px solid var(--border);
  padding: 6px 0;
}
.file {
  display: flex;
  gap: 6px;
  padding: 5px 12px;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file:hover {
  background: var(--hover);
}
.file.on {
  background: var(--accent-soft);
}
.file .st {
  color: var(--red);
}
.file.done .st {
  color: var(--green);
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.bar.actions {
  background: color-mix(in srgb, var(--red) 6%, var(--surface));
}
.fname {
  font-family: var(--font-code);
  font-size: 12.5px;
  font-weight: 600;
}
.stat {
  font-size: 12px;
  color: var(--text-dim);
}
.pos {
  font-size: 12px;
  min-width: 46px;
  text-align: center;
}
.labels {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}
.labels span {
  padding: 5px 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.labels span:nth-child(2) {
  color: var(--accent);
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
}
.eds {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
}
.ed {
  min-height: 0;
  min-width: 0;
}
.ed.mid {
  border-left: 1px solid var(--border-strong);
  border-right: 1px solid var(--border-strong);
}
.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
}
.legend {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
}
.sw {
  display: inline-block;
  width: 12px;
  height: 10px;
  border-radius: 2px;
  margin-left: 8px;
}
.sw.auto {
  background: rgba(64, 160, 255, 0.35);
}
.sw.conflict {
  background: rgba(229, 72, 77, 0.45);
}
.sw.ok {
  background: rgba(52, 199, 89, 0.4);
}
.alldone {
  padding: 30px;
  line-height: 1.8;
}
.row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.error {
  margin: 8px 12px;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--red);
  background: color-mix(in srgb, var(--red) 8%, var(--surface));
  white-space: pre-wrap;
  font-size: 12.5px;
  user-select: text;
}
.btn.small {
  height: 24px;
  padding: 0 9px;
  font-size: 12px;
}
</style>
