<script setup lang="ts">
/**
 * Query results under a .sql editor. The grid draws only the rows in view, so even the
 * maximum fetch stays smooth.
 *
 * Results of a plain single-table SELECT that include the primary key can be edited
 * (IntelliJ / DBeaver style): double-click or type to change a cell, Alt+Insert adds a row,
 * Delete marks rows for delete, Ctrl+S saves (UPDATE / INSERT / DELETE by PK, all or nothing).
 * With manual commit the save stays in the open transaction until [커밋].
 */
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue'
import Icon from '../Icon.vue'
import { db, connOf, schemasOf, objectsOf, columnsOf, qualified, saveStatements, txOf, type ResultItem, type DbColumn, type GridEdit, type SaveStatement } from '../../db'
import { singleTable, blankLiterals, sqlName, literal, placeholder, isBinaryType, unquote } from '../../dbsql'
import { openMenu } from '../../ui'
import { toast } from '../../ide'

const props = defineProps<{ path: string }>()

const rs = computed(() => db.results[props.path])
const item = computed<ResultItem | undefined>(() => rs.value?.items[rs.value.active])
const res = computed(() => item.value?.result)
const conn = computed(() => (rs.value ? connOf(rs.value.connId) : undefined))
const tx = computed(() => txOf(rs.value?.connId))

const ROW_H = 24
const RN_W = 52
const scroller = ref<HTMLDivElement>()
const scrollTop = ref(0)
const viewH = ref(1500)
const widths = ref<number[]>([])
const editing = ref<{ r: number; c: number; value: string } | null>(null)
const input = ref<HTMLTextAreaElement>()
const saving = ref(false)
const saveError = ref('')
const preview = ref(false)

const NUM = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i

/* ---------------------------------------------------------------- selection (anchor + focus = rectangle) */

interface Pos {
  r: number
  c: number
}
const anchor = ref<Pos | null>(null)
const focus = ref<Pos | null>(null)
const rect = computed(() => {
  if (!anchor.value || !focus.value) return null
  return {
    r1: Math.min(anchor.value.r, focus.value.r),
    r2: Math.max(anchor.value.r, focus.value.r),
    c1: Math.min(anchor.value.c, focus.value.c),
    c2: Math.max(anchor.value.c, focus.value.c)
  }
})
const inRect = (r: number, c: number): boolean => {
  const x = rect.value
  return !!x && r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2
}

function selectCell(r: number, c: number, extend = false): void {
  focus.value = { r, c }
  if (!extend || !anchor.value) anchor.value = { r, c }
}

/* ---------------------------------------------------------------- data + edits */

const edit = computed<GridEdit | undefined>(() => item.value?.edit)
const base = computed(() => res.value?.rows.length ?? 0)
const total = computed(() => base.value + (edit.value?.added.length ?? 0))

function ensureEdit(): GridEdit {
  const it = item.value!
  if (!it.edit) it.edit = { cells: {}, deleted: {}, added: [] }
  return it.edit
}

const isAdded = (r: number): boolean => r >= base.value
const isDeleted = (r: number): boolean => !!edit.value?.deleted[r]
const changed = (r: number, c: number): boolean => !isAdded(r) && !!edit.value && `${r}:${c}` in edit.value.cells

function value(r: number, c: number): unknown {
  if (isAdded(r)) return edit.value?.added[r - base.value]?.[c]
  const e = edit.value
  const k = `${r}:${c}`
  if (e && k in e.cells) return e.cells[k]
  return res.value?.rows[r]?.[c]
}

const counts = computed(() => {
  const e = edit.value
  if (!e) return { upd: 0, del: 0, add: 0, all: 0 }
  const upd = new Set(Object.keys(e.cells).map((k) => Number(k.split(':')[0])).filter((r) => !e.deleted[r])).size
  const del = Object.keys(e.deleted).length
  const add = e.added.length
  return { upd, del, add, all: upd + del + add }
})

// close warning (db.ts) needs to know about unsaved grid edits
watch(
  () => rs.value?.items.reduce((n, it) => n + (it.edit ? Object.keys(it.edit.cells).length + Object.keys(it.edit.deleted).length + it.edit.added.length : 0), 0) ?? 0,
  (n) => {
    if (n) db.unsavedEdits[props.path] = n
    else delete db.unsavedEdits[props.path]
  },
  { immediate: true }
)
onBeforeUnmount(() => delete db.unsavedEdits[props.path])

/* ---------------------------------------------------------------- can this result be edited? */

interface EditInfo {
  /** table name as written in generated SQL */
  table: string
  label: string
  /** table column for each result column (null = expression / alias / unknown) */
  cols: (DbColumn | null)[]
  /** result column indexes of the primary key */
  pk: number[]
}
const info = ref<EditInfo | null>(null)
const reason = ref('')
let token = 0

/** output names of select-list expressions (`UPPER(name) AS name` must not count as the column) */
function computedOutputs(sql: string): Set<string> {
  const s = blankLiterals(sql)
  const m = s.match(/^\s*select\s+(?:top\s+\(?\d+\)?\s+)?([\s\S]*?)\s+from\b/i)
  const out = new Set<string>()
  if (!m) return out
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of m[1]) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  const ID = String.raw`(?:[\w$#À-￿]+|"[^"]+"|\`[^\`]+\`|\[[^\]]+\])`
  const plain = new RegExp(`^(?:${ID}\\s*\\.\\s*)?(${ID})(?:\\s+(?:as\\s+)?(${ID}))?$`, 'i')
  for (const p of parts.map((x) => x.trim())) {
    if (/^(?:[\w$#]+\.)?\*$/.test(p)) continue
    const pm = p.match(plain)
    if (pm) {
      // `name AS other`: the output is not the column of that name
      if (pm[2] && unquote(pm[2]).toLowerCase() !== unquote(pm[1]).toLowerCase()) out.add(unquote(pm[2]).toLowerCase())
      continue
    }
    const alias = p.match(new RegExp(`(?:\\bas\\s+|\\s)(${ID})$`, 'i'))?.[1]
    if (alias) out.add(unquote(alias).toLowerCase())
  }
  return out
}

async function analyze(): Promise<void> {
  const my = ++token
  info.value = null
  reason.value = ''
  const it = item.value
  const r = res.value
  const c = conn.value
  if (!it || !r || !r.columns.length || !c) return
  const set = (why: string): void => {
    if (my === token) reason.value = why
  }
  if (c.readOnly) return set('읽기 전용 연결이라 수정할 수 없습니다')
  const ref = singleTable(it.sql)
  if (!ref) return set('테이블 하나를 조회한 결과만 수정할 수 있습니다 (JOIN · GROUP BY · 서브쿼리 제외)')
  try {
    const { schemas, current } = await schemasOf(c.id)
    const want = (ref.schema ?? current).toLowerCase()
    const schema = schemas.find((s) => s.toLowerCase() === want) ?? ref.schema ?? current
    const obj = (await objectsOf(c.id, schema)).find((o) => o.name.toLowerCase() === ref.name.toLowerCase())
    if (!obj) return set(`'${ref.name}' 테이블 정보를 찾지 못했습니다`)
    if (obj.type === 'view') return set('뷰는 수정할 수 없습니다')
    const tcols = await columnsOf(c.id, schema, obj.name)
    const skip = computedOutputs(it.sql)
    const cols = r.columns.map((name) => (skip.has(name.toLowerCase()) ? null : tcols.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null))
    const pkCols = tcols.filter((t) => t.pk)
    if (!pkCols.length) return set('PK 가 없는 테이블이라 수정할 수 없습니다')
    const pk = pkCols.map((p) => cols.findIndex((x) => x === p))
    const missing = pkCols.filter((_, i) => pk[i] < 0).map((p) => p.name)
    if (missing.length) return set(`PK 컬럼(${missing.join(', ')})이 결과에 있어야 수정할 수 있습니다`)
    if (my !== token) return
    info.value = { table: qualified(c, schema, obj.name), label: obj.name, cols, pk }
  } catch (e) {
    set(`테이블 정보를 읽지 못했습니다: ${(e as Error).message}`)
  }
}

const canEdit = (c: number): boolean => {
  const col = info.value?.cols[c]
  return !!col && !isBinaryType(col.type)
}

/* new result: reset view, analyze */
watch(
  res,
  (r) => {
    anchor.value = focus.value = null
    editing.value = null
    preview.value = false
    saveError.value = ''
    scrollTop.value = 0
    if (scroller.value) scroller.value.scrollTop = 0
    if (r) {
      widths.value = r.columns.map((name, c) => {
        let len = name.length
        for (const row of r.rows.slice(0, 200)) {
          const v = row[c]
          const s = v === null ? 6 : String(v).length
          if (s > len) len = s
        }
        return Math.max(60, Math.min(360, Math.round(len * 7.4 + 22)))
      })
    }
    void analyze()
  },
  { immediate: true }
)

/* ---------------------------------------------------------------- virtual rows */

const first = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - 5))
const last = computed(() => Math.min(total.value, Math.ceil((scrollTop.value + viewH.value) / ROW_H) + 5))
const visible = computed(() => {
  const out: number[] = []
  for (let r = first.value; r < last.value; r++) out.push(r)
  return out
})
const totalW = computed(() => RN_W + widths.value.reduce((a, b) => a + b, 0))
const leftOf = (c: number): number => RN_W + widths.value.slice(0, c).reduce((a, b) => a + b, 0)

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  scrollTop.value = el.scrollTop
  viewH.value = el.clientHeight
}

function reveal(r: number): void {
  const el = scroller.value
  if (!el) return
  const top = (r + 1) * ROW_H
  if (top - ROW_H < el.scrollTop) el.scrollTop = top - ROW_H
  else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
}

const show = (v: unknown): string => (v === undefined ? '<default>' : v === null ? '<null>' : String(v))
const tsv = (v: unknown): string => (v === null || v === undefined ? '' : String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' '))

/* ---------------------------------------------------------------- copy */

function copy(text: string): void {
  void navigator.clipboard.writeText(text)
}

function copySelection(): void {
  const x = rect.value
  if (!x) return
  if (x.r1 === x.r2 && x.c1 === x.c2) {
    const v = value(x.r1, x.c1)
    copy(v === null || v === undefined ? 'NULL' : String(v))
    return
  }
  const lines: string[] = []
  for (let r = x.r1; r <= x.r2; r++) {
    const cells: string[] = []
    for (let c = x.c1; c <= x.c2; c++) cells.push(tsv(value(r, c)))
    lines.push(cells.join('\t'))
  }
  copy(lines.join('\n'))
}

function copyAll(): void {
  const r = res.value
  if (!r) return
  const rows: string[] = [r.columns.join('\t')]
  for (let i = 0; i < total.value; i++) rows.push(r.columns.map((_, c) => tsv(value(i, c))).join('\t'))
  copy(rows.join('\n'))
}

const selRows = (): number[] => {
  const x = rect.value
  if (!x) return []
  const out: number[] = []
  for (let r = x.r1; r <= x.r2; r++) out.push(r)
  return out
}

/** table name for copied statements (also for results that can't be edited) */
const tableForSql = (): string => {
  if (info.value) return info.value.table
  const t = item.value ? singleTable(item.value.sql) : null
  return t && conn.value ? sqlName(conn.value.kind, t.name) : 'TABLE_NAME'
}
const typeOf = (c: number): string => info.value?.cols[c]?.type ?? ''
const colName = (c: number): string => sqlName(conn.value?.kind ?? 'mysql', info.value?.cols[c]?.name ?? res.value?.columns[c] ?? '')

function copyInsert(): void {
  const r = res.value
  const k = conn.value?.kind
  if (!r || !k) return
  const all = r.columns.map((_, c) => c)
  const cols = info.value ? all.filter((c) => info.value!.cols[c]) : all
  const head = `INSERT INTO ${tableForSql()} (${cols.map(colName).join(', ')}) VALUES `
  copy(selRows().map((row) => `${head}(${cols.map((c) => literal(k, value(row, c) ?? null, typeOf(c))).join(', ')});`).join('\n'))
}

function copyUpdate(): void {
  const k = conn.value?.kind
  const inf = info.value
  if (!k || !inf) return
  const out = selRows()
    .filter((row) => !isAdded(row))
    .map((row) => {
      const set = inf.cols
        .map((col, c) => (col && !col.pk ? `${colName(c)} = ${literal(k, value(row, c), col.type)}` : ''))
        .filter(Boolean)
      const where = inf.pk.map((c) => `${colName(c)} = ${literal(k, res.value!.rows[row][c], typeOf(c))}`).join(' AND ')
      return `UPDATE ${inf.table} SET ${set.join(', ')} WHERE ${where};`
    })
  copy(out.join('\n'))
}

/* ---------------------------------------------------------------- editing */


function startEdit(r: number, c: number, initial?: string): void {
  if (!canEdit(c) || isDeleted(r)) return
  const v = value(r, c)
  editing.value = { r, c, value: initial ?? (v === null || v === undefined ? '' : String(v)) }
  selectCell(r, c)
  void nextTick(() => {
    const el = input.value
    if (!el) return
    el.focus()
    if (initial === undefined) el.select()
    else el.setSelectionRange(el.value.length, el.value.length)
  })
}

function setValue(r: number, c: number, v: unknown): void {
  const e = ensureEdit()
  if (isAdded(r)) {
    const row = e.added[r - base.value]
    // leaving a new row's cell empty keeps the column default
    if (v === '' && row[c] === undefined) return
    row[c] = v
    return
  }
  const orig = res.value?.rows[r]?.[c]
  const same = v === null ? orig === null : orig !== null && orig !== undefined && String(orig) === v
  const k = `${r}:${c}`
  if (same) delete e.cells[k]
  else e.cells[k] = v
}

function finishEdit(save: boolean, move?: [number, number]): void {
  const ed = editing.value
  if (!ed) return
  editing.value = null
  if (save) setValue(ed.r, ed.c, ed.value)
  scroller.value?.focus()
  if (move) {
    const r = Math.max(0, Math.min(total.value - 1, ed.r + move[0]))
    const c = Math.max(0, Math.min((res.value?.columns.length ?? 1) - 1, ed.c + move[1]))
    selectCell(r, c)
    reveal(r)
  }
}

function onEditKey(e: KeyboardEvent): void {
  e.stopPropagation()
  if (e.key === 'Escape') {
    e.preventDefault()
    finishEdit(false)
  } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    e.preventDefault()
    finishEdit(true, [1, 0])
  } else if (e.key === 'Tab') {
    e.preventDefault()
    finishEdit(true, [0, e.shiftKey ? -1 : 1])
  }
}

function setNull(): void {
  const x = rect.value
  if (!x || !info.value) return
  for (let r = x.r1; r <= x.r2; r++) for (let c = x.c1; c <= x.c2; c++) if (canEdit(c) && !isDeleted(r)) setValue(r, c, null)
}

function addRow(): void {
  if (!info.value || !res.value) return
  const e = ensureEdit()
  e.added.push(res.value.columns.map(() => undefined))
  const r = total.value - 1
  const c = info.value.cols.findIndex((_, i) => canEdit(i))
  void nextTick(() => {
    reveal(r)
    if (c >= 0) startEdit(r, c)
  })
}

function deleteRows(): void {
  if (!info.value) return
  const e = ensureEdit()
  const rows = selRows()
  // new rows are simply dropped (highest first so indexes stay valid)
  for (const r of [...rows].reverse()) if (isAdded(r)) e.added.splice(r - base.value, 1)
  for (const r of rows) if (!isAdded(r)) e.deleted[r] = true
  if (focus.value && focus.value.r >= total.value) selectCell(Math.max(0, total.value - 1), focus.value.c)
}

function revertSelection(): void {
  const e = edit.value
  const x = rect.value
  if (!e || !x) return
  for (let r = x.r1; r <= x.r2; r++) {
    delete e.deleted[r]
    for (let c = x.c1; c <= x.c2; c++) delete e.cells[`${r}:${c}`]
  }
}

function revertAll(): void {
  if (item.value) item.value.edit = undefined
  preview.value = false
  saveError.value = ''
}

/* ---------------------------------------------------------------- save */


/** UPDATE / DELETE / INSERT for the pending edits: bind version (run) and literal version (preview) */
function build(): { run: SaveStatement[]; text: string[] } {
  const inf = info.value
  const e = edit.value
  const k = conn.value?.kind
  const r0 = res.value
  if (!inf || !e || !k || !r0) return { run: [], text: [] }
  const run: SaveStatement[] = []
  const text: string[] = []
  const where = (row: number): { sql: string; params: unknown[]; lit: string } => ({
    sql: inf.pk.map((c) => `${colName(c)} = ${placeholder(k, typeOf(c))}`).join(' AND '),
    params: inf.pk.map((c) => r0.rows[row][c]),
    lit: inf.pk.map((c) => `${colName(c)} = ${literal(k, r0.rows[row][c], typeOf(c))}`).join(' AND ')
  })
  // updates (rows not deleted), grouped per row
  const byRow = new Map<number, number[]>()
  for (const key of Object.keys(e.cells)) {
    const [r, c] = key.split(':').map(Number)
    if (e.deleted[r]) continue
    byRow.set(r, [...(byRow.get(r) ?? []), c].sort((a, b) => a - b))
  }
  for (const [r, cs] of [...byRow].sort((a, b) => a[0] - b[0])) {
    const w = where(r)
    const vals = cs.map((c) => e.cells[`${r}:${c}`])
    run.push({
      sql: `UPDATE ${inf.table} SET ${cs.map((c) => `${colName(c)} = ${placeholder(k, typeOf(c))}`).join(', ')} WHERE ${w.sql}`,
      params: [...vals, ...w.params],
      expect: 1
    })
    text.push(`UPDATE ${inf.table} SET ${cs.map((c, i) => `${colName(c)} = ${literal(k, vals[i], typeOf(c))}`).join(', ')} WHERE ${w.lit};`)
  }
  for (const r of Object.keys(e.deleted).map(Number).sort((a, b) => a - b)) {
    const w = where(r)
    run.push({ sql: `DELETE FROM ${inf.table} WHERE ${w.sql}`, params: w.params, expect: 1 })
    text.push(`DELETE FROM ${inf.table} WHERE ${w.lit};`)
  }
  for (const row of e.added) {
    const cs = row.map((v, c) => (v !== undefined && inf.cols[c] ? c : -1)).filter((c) => c >= 0)
    if (!cs.length) continue
    run.push({
      sql: `INSERT INTO ${inf.table} (${cs.map(colName).join(', ')}) VALUES (${cs.map((c) => placeholder(k, typeOf(c))).join(', ')})`,
      params: cs.map((c) => row[c]),
      expect: 1
    })
    text.push(`INSERT INTO ${inf.table} (${cs.map(colName).join(', ')}) VALUES (${cs.map((c) => literal(k, row[c], typeOf(c))).join(', ')});`)
  }
  return { run, text }
}

const previewText = computed(() => (preview.value ? build().text.join('\n') : ''))

async function save(): Promise<void> {
  const it = item.value
  const id = rs.value?.connId
  if (!it || !id || !info.value || saving.value) return
  if (editing.value) finishEdit(true)
  const { run } = build()
  if (!run.length) {
    revertAll()
    return
  }
  saving.value = true
  saveError.value = ''
  try {
    const n = await saveStatements(id, run)
    it.edit = undefined
    preview.value = false
    toast(txOf(id).manual ? `${n}행 저장 · 커밋해야 확정됩니다` : `${n}행 저장했습니다`, 'ok')
    // read the rows again (generated keys, defaults, triggers)
    try {
      const r = (await window.api.db.query(id, it.sql)) as unknown as NonNullable<ResultItem['result']>
      it.result = r
      if (r.tx) db.tx[id] = r.tx
    } catch {
      /* keep the old rows */
    }
  } catch (e) {
    saveError.value = (e as Error).message
    toast(`저장 실패: ${saveError.value.split('\n')[0]}`, 'error')
  } finally {
    saving.value = false
  }
}

/* ---------------------------------------------------------------- mouse / keys */

let dragging = false
function down(e: MouseEvent, r: number, c: number): void {
  if (e.button !== 0) return
  if (editing.value) finishEdit(true)
  selectCell(r, c, e.shiftKey)
  dragging = true
  window.addEventListener('mouseup', () => (dragging = false), { once: true })
}
function enter(r: number, c: number): void {
  if (dragging) focus.value = { r, c }
}
function rowDown(e: MouseEvent, r: number): void {
  if (e.button !== 0) return
  const lastC = (res.value?.columns.length ?? 1) - 1
  if (e.shiftKey && anchor.value) focus.value = { r, c: lastC }
  else {
    anchor.value = { r, c: 0 }
    focus.value = { r, c: lastC }
  }
}

function cellMenu(e: MouseEvent, r: number, c: number): void {
  if (!inRect(r, c)) selectCell(r, c)
  const ed = !!info.value
  const n = selRows().length
  openMenu(e, [
    { label: '복사', hint: 'Ctrl+C', action: copySelection },
    { label: '전체 복사 (엑셀에 붙여넣기)', action: copyAll },
    { label: `열 이름 복사 (${res.value?.columns[c]})`, action: () => copy(res.value?.columns[c] ?? '') },
    { label: `INSERT 문으로 복사 (${n}행)`, sep: true, action: copyInsert },
    { label: `UPDATE 문으로 복사 (${n}행)`, disabled: !ed, action: copyUpdate },
    ...(ed
      ? [
          { label: '값 수정', sep: true, hint: '더블클릭 · F2', disabled: !canEdit(c), action: () => startEdit(r, c) },
          { label: 'NULL 로 설정', hint: 'Ctrl+Alt+N', action: setNull },
          { label: '행 추가', hint: 'Alt+Insert', action: addRow },
          { label: `행 삭제 (${n}행)`, hint: 'Delete', danger: true, action: deleteRows },
          { label: '선택 영역 변경 되돌리기', hint: 'Ctrl+Z', disabled: !counts.value.all, action: revertSelection }
        ]
      : [{ label: '수정할 수 없는 결과', sep: true, hint: reason.value, disabled: true }])
  ])
}

function onKey(e: KeyboardEvent): void {
  const r0 = res.value
  if (!r0) return
  const ctrl = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  const handled = (): void => {
    e.preventDefault()
    e.stopPropagation()
  }
  if (ctrl && key === 's') {
    handled()
    void save()
    return
  }
  if (ctrl && key === 'a') {
    handled()
    anchor.value = { r: 0, c: 0 }
    focus.value = { r: total.value - 1, c: r0.columns.length - 1 }
    return
  }
  // adding a row needs no selected cell (after a save the rows are read again and the selection is reset)
  if (info.value && e.altKey && e.key === 'Insert') return (handled(), addRow())
  const f = focus.value
  if (!f) return
  if (ctrl && key === 'c') {
    handled()
    copySelection()
    return
  }
  if (info.value) {
    if (ctrl && e.altKey && key === 'n') return (handled(), setNull())
    if (e.key === 'Delete' || (ctrl && key === 'y')) return (handled(), deleteRows())
    if (ctrl && key === 'z') return (handled(), revertSelection())
    if (e.key === 'F2' || e.key === 'Enter') return (handled(), startEdit(f.r, f.c))
    // typing starts editing with that character (IntelliJ)
    if (e.key.length === 1 && !ctrl && !e.altKey && canEdit(f.c)) return (handled(), startEdit(f.r, f.c, e.key))
  }
  const move: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, e.shiftKey ? -1 : 1] }
  const d = move[e.key]
  if (!d) return
  handled()
  const r = Math.max(0, Math.min(total.value - 1, f.r + d[0]))
  const c = Math.max(0, Math.min(r0.columns.length - 1, f.c + d[1]))
  selectCell(r, c, e.shiftKey && e.key !== 'Tab')
  reveal(r)
}

/* ---------------------------------------------------------------- column resize / panel height */

let drag: { c: number; x: number; w: number } | null = null
function startResize(e: MouseEvent, c: number): void {
  e.preventDefault()
  e.stopPropagation()
  drag = { c, x: e.clientX, w: widths.value[c] }
  window.addEventListener('mousemove', onResize)
  window.addEventListener('mouseup', endResize, { once: true })
}
function onResize(e: MouseEvent): void {
  if (drag) widths.value[drag.c] = Math.max(40, drag.w + e.clientX - drag.x)
}
function endResize(): void {
  drag = null
  window.removeEventListener('mousemove', onResize)
}

function startHeight(e: MouseEvent): void {
  e.preventDefault()
  const y0 = e.clientY
  const h0 = db.resultHeight
  const move = (ev: MouseEvent): void => {
    db.resultHeight = Math.max(90, Math.min(window.innerHeight - 200, h0 - (ev.clientY - y0)))
  }
  window.addEventListener('mousemove', move)
  window.addEventListener(
    'mouseup',
    () => {
      window.removeEventListener('mousemove', move)
      try {
        localStorage.setItem('mixdog.dbResultHeight', String(db.resultHeight))
      } catch {
        /* storage unavailable */
      }
    },
    { once: true }
  )
}
onBeforeUnmount(endResize)

const status = computed(() => {
  const it = item.value
  if (!it) return ''
  if (it.error) return '오류'
  const r = it.result
  if (!r) return '실행 중…'
  const word = it.sql.trim().replace(/;\s*$/, '').toLowerCase()
  if (/^commit\b/.test(word)) return `커밋했습니다 · ${r.ms}ms`
  if (/^rollback\b/.test(word)) return `롤백했습니다 · ${r.ms}ms`
  if (!r.columns.length) return `${(r.affected ?? 0).toLocaleString()}행 변경됨 · ${r.ms}ms`
  return `${r.rows.length.toLocaleString()}행${r.more ? ` (더 있음 · 처음 ${r.rows.length.toLocaleString()}행만 가져옴)` : ''} · ${r.ms}ms`
})

const changeText = computed(() => {
  const x = counts.value
  return [x.upd && `수정 ${x.upd}`, x.add && `추가 ${x.add}`, x.del && `삭제 ${x.del}`].filter(Boolean).join(' · ') + '행'
})

const tabLabel = (it: ResultItem, i: number): string => {
  const head = it.sql.replace(/\s+/g, ' ').trim().slice(0, 28)
  return `${i + 1}. ${head}`
}
</script>

<template>
  <div v-if="rs" class="results" :style="{ height: db.resultHeight + 'px' }">
    <div class="grip" @mousedown="startHeight" />
    <div class="rhead">
      <div v-if="rs.items.length > 1" class="tabs">
        <button
          v-for="(it, i) in rs.items"
          :key="i"
          class="rtab"
          :class="{ on: i === rs.active, err: it.error, dirty: it.edit }"
          :title="it.sql"
          @click="rs.active = i"
        >
          {{ tabLabel(it, i) }}
        </button>
      </div>
      <span class="status" :class="{ err: item?.error }">{{ status }}</span>
      <span v-if="info" class="editable" :title="`${info.label} 테이블 · 더블클릭/F2 수정 · Alt+Insert 행 추가 · Delete 행 삭제 · Ctrl+S 저장`">
        <Icon name="edit" :size="11" />{{ info.label }}
      </span>
      <span v-else-if="reason && res?.columns.length" class="noedit" :title="reason">읽기 전용 결과</span>
      <span class="grow" />
      <button v-if="res?.columns.length" class="icon-btn" title="전체 복사 (탭 구분, 엑셀에 붙여넣기)" @click="copyAll"><Icon name="file" :size="13" /></button>
      <button v-if="info" class="icon-btn" title="행 추가 (Alt+Insert)" @click="addRow"><Icon name="rowAdd" :size="13" /></button>
      <button v-if="info" class="icon-btn" title="선택한 행 삭제 (Delete)" :disabled="!rect" @click="deleteRows"><Icon name="rowDel" :size="13" /></button>
      <button class="icon-btn" title="결과 닫기" @click="delete db.results[path]"><Icon name="x" :size="13" /></button>
    </div>

    <div v-if="counts.all" class="savebar">
      <span class="chg-n">{{ changeText }}</span>
      <span class="dim">{{ tx.manual ? '저장해도 [커밋] 전까지는 확정되지 않습니다' : '저장하면 바로 커밋됩니다' }}</span>
      <span class="grow" />
      <button class="sbtn" @click="preview = !preview">{{ preview ? 'SQL 닫기' : 'SQL 미리보기' }}</button>
      <button class="sbtn" :disabled="saving" @click="revertAll">되돌리기</button>
      <button class="sbtn primary" :disabled="saving" @click="save"><Icon name="save" :size="12" />{{ saving ? '저장 중…' : '저장 (Ctrl+S)' }}</button>
    </div>
    <div v-if="saveError" class="saveerr">{{ saveError }}</div>
    <pre v-if="preview" class="preview">{{ previewText }}</pre>

    <div v-if="item?.error" class="error">
      <div class="emsg">{{ item.error }}</div>
      <div class="esql">{{ item.sql }}</div>
    </div>
    <div v-else-if="rs.running && !res" class="note">실행 중…</div>
    <div v-else-if="res && !res.columns.length" class="note">{{ status }}</div>
    <div v-else-if="res" ref="scroller" class="grid" tabindex="0" @scroll="onScroll" @keydown="onKey">
      <div class="inner" :style="{ width: totalW + 'px', height: (total + 1) * ROW_H + 'px' }">
        <div class="hrow" :style="{ width: totalW + 'px' }">
          <div class="rn" />
          <div
            v-for="(col, c) in res.columns"
            :key="c"
            class="hc"
            :class="{ ro: info && !canEdit(c) }"
            :style="{ width: widths[c] + 'px' }"
            :title="info?.cols[c] ? `${col} · ${info.cols[c]!.type}${info.cols[c]!.comment ? ' · ' + info.cols[c]!.comment : ''}` : col"
          >
            <Icon v-if="info?.cols[c]?.pk" name="key" :size="11" class="pk" />{{ col }}
            <span class="rs" @mousedown="startResize($event, c)" />
          </div>
        </div>
        <div
          v-for="r in visible"
          :key="r"
          class="drow"
          :class="{ odd: r % 2, del: isDeleted(r), add: isAdded(r) }"
          :style="{ top: (r + 1) * ROW_H + 'px', width: totalW + 'px' }"
        >
          <div class="rn" :class="{ on: rect && r >= rect.r1 && r <= rect.r2 }" @mousedown="rowDown($event, r)">{{ isAdded(r) ? '+' : r + 1 }}</div>
          <div
            v-for="(_, c) in res.columns"
            :key="c"
            class="dc"
            :class="{
              nul: value(r, c) === null || value(r, c) === undefined,
              num: typeof value(r, c) === 'number' || (typeof value(r, c) === 'string' && NUM.test(value(r, c) as string)),
              sel: inRect(r, c),
              cur: focus?.r === r && focus?.c === c,
              chg: changed(r, c) || (isAdded(r) && value(r, c) !== undefined)
            }"
            :style="{ width: widths[c] + 'px' }"
            :title="value(r, c) != null && String(value(r, c)).length > 40 ? String(value(r, c)).slice(0, 2000) : undefined"
            @mousedown="down($event, r, c)"
            @mouseenter="enter(r, c)"
            @dblclick="startEdit(r, c)"
            @contextmenu="cellMenu($event, r, c)"
          >
            {{ show(value(r, c)) }}
          </div>
        </div>
        <textarea
          v-if="editing"
          ref="input"
          v-model="editing.value"
          class="cell-input"
          spellcheck="false"
          :style="{ top: (editing.r + 1) * ROW_H + 'px', left: leftOf(editing.c) + 'px', width: Math.max(widths[editing.c], 120) + 'px' }"
          @keydown="onEditKey"
          @blur="finishEdit(true)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.results {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--border-strong);
  background: var(--surface);
}
.grip {
  position: absolute;
  left: 0;
  right: 0;
  top: -4px;
  height: 7px;
  cursor: row-resize;
  z-index: 3;
}
.rhead {
  height: 30px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 8px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 12px;
}
.tabs {
  display: flex;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
}
.rtab {
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
  white-space: nowrap;
  font-family: var(--font-code);
}
.rtab:hover {
  background: var(--hover);
}
.rtab.on {
  color: var(--text);
  background: var(--accent-soft);
}
.rtab.err {
  color: var(--red);
}
.rtab.dirty::after {
  content: ' ●';
  color: #d9a400;
}
.status {
  color: var(--text-dim);
  white-space: nowrap;
}
.status.err {
  color: var(--red);
}
.editable {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--accent);
  background: var(--accent-soft);
  white-space: nowrap;
}
.noedit {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  cursor: help;
}
.grow {
  flex: 1;
}
.icon-btn {
  width: 24px;
  height: 22px;
}
.icon-btn:disabled {
  opacity: 0.35;
}
.savebar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px 0 10px;
  font-size: 12px;
  background: color-mix(in srgb, #d9a400 12%, var(--surface));
  border-bottom: 1px solid var(--border);
}
.chg-n {
  font-weight: 600;
  white-space: nowrap;
}
.dim {
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sbtn {
  height: 22px;
  padding: 0 9px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  border: 1px solid var(--border-strong);
  background: var(--surface);
}
.sbtn:hover:not(:disabled) {
  background: var(--hover);
}
.sbtn.primary {
  color: #fff;
  border-color: var(--accent);
  background: var(--accent);
}
.sbtn:disabled {
  opacity: 0.5;
}
.saveerr {
  flex-shrink: 0;
  max-height: 80px;
  overflow: auto;
  padding: 6px 10px;
  color: var(--red);
  font-family: var(--font-code);
  font-size: 11.5px;
  white-space: pre-wrap;
  user-select: text;
  border-bottom: 1px solid var(--border);
}
.preview {
  flex-shrink: 0;
  max-height: 120px;
  overflow: auto;
  margin: 0;
  padding: 6px 10px;
  font-family: var(--font-code);
  font-size: 11.5px;
  user-select: text;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.note {
  padding: 12px 14px;
  color: var(--text-dim);
}
.error {
  padding: 10px 14px;
  overflow: auto;
  user-select: text;
}
.emsg {
  color: var(--red);
  white-space: pre-wrap;
  font-family: var(--font-code);
  font-size: 12px;
}
.esql {
  margin-top: 8px;
  color: var(--text-dim);
  white-space: pre-wrap;
  font-family: var(--font-code);
  font-size: 11.5px;
}
.grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  outline: none;
  font-family: var(--font-code);
  font-size: 12px;
  user-select: none;
}
.inner {
  position: relative;
}
.hrow,
.drow {
  display: flex;
  height: 24px;
}
.hrow {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-strong);
  font-weight: 600;
}
.drow {
  position: absolute;
  left: 0;
}
.drow.odd {
  background: color-mix(in srgb, var(--text) 3%, transparent);
}
.drow.add {
  background: color-mix(in srgb, var(--green) 10%, transparent);
}
.drow.del .dc {
  color: var(--red);
  text-decoration: line-through;
  background: color-mix(in srgb, var(--red) 8%, transparent);
}
.rn {
  flex: 0 0 52px;
  padding: 0 8px;
  text-align: right;
  color: var(--text-faint);
  line-height: 24px;
  position: sticky;
  left: 0;
  background: var(--surface-2);
  border-right: 1px solid var(--border);
  z-index: 1;
}
.drow .rn {
  cursor: pointer;
}
.rn.on {
  color: var(--text);
  background: var(--accent-soft);
}
.hc,
.dc {
  flex-shrink: 0;
  padding: 0 8px;
  line-height: 24px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  border-right: 1px solid var(--border);
}
.hc {
  position: relative;
  display: flex;
  align-items: center;
  gap: 3px;
}
.hc.ro {
  color: var(--text-dim);
  font-weight: 500;
}
.hc .pk {
  flex-shrink: 0;
  color: #d9a400;
}
.rs {
  position: absolute;
  right: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 1;
}
.dc.num {
  text-align: right;
}
.dc.nul {
  color: var(--text-faint);
  font-style: italic;
}
.dc.sel {
  background: var(--accent-soft);
}
.dc.cur {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.dc.chg {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  font-style: normal;
}
.cell-input {
  position: absolute;
  z-index: 4;
  height: 24px;
  min-height: 24px;
  padding: 2px 7px;
  margin: 0;
  resize: none;
  overflow: hidden;
  font: inherit;
  line-height: 19px;
  color: var(--text);
  background: var(--surface);
  border: 1.5px solid var(--accent);
  border-radius: 2px;
  outline: none;
  white-space: pre;
}
</style>
