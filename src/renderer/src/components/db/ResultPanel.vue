<script setup lang="ts">
/**
 * Query results under a .sql editor. The grid draws only the rows in view, so even the
 * maximum fetch stays smooth. Click a cell to select it, Ctrl+C copies, right-click for more.
 */
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import Icon from '../Icon.vue'
import { db, type ResultItem } from '../../db'
import { openMenu } from '../../ui'

const props = defineProps<{ path: string }>()

const rs = computed(() => db.results[props.path])
const item = computed<ResultItem | undefined>(() => rs.value?.items[rs.value.active])
const res = computed(() => item.value?.result)

const ROW_H = 24
const scroller = ref<HTMLDivElement>()
const scrollTop = ref(0)
const viewH = ref(1500)
const sel = ref<{ r: number; c: number } | null>(null)
const widths = ref<number[]>([])

const NUM = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i

/** column widths from the header and the first rows */
watch(
  res,
  (r) => {
    sel.value = null
    scrollTop.value = 0
    if (scroller.value) scroller.value.scrollTop = 0
    if (!r) return
    widths.value = r.columns.map((name, c) => {
      let len = name.length
      for (const row of r.rows.slice(0, 200)) {
        const v = row[c]
        const s = v === null ? 6 : String(v).length
        if (s > len) len = s
      }
      return Math.max(60, Math.min(360, Math.round(len * 7.4 + 22)))
    })
  },
  { immediate: true }
)

const first = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - 5))
const last = computed(() => Math.min(res.value?.rows.length ?? 0, Math.ceil((scrollTop.value + viewH.value) / ROW_H) + 5))
const visible = computed(() => (res.value?.rows ?? []).slice(first.value, last.value).map((row, i) => ({ row, r: first.value + i })))
const totalW = computed(() => 52 + widths.value.reduce((a, b) => a + b, 0))

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  scrollTop.value = el.scrollTop
  viewH.value = el.clientHeight
}

const show = (v: unknown): string => (v === null ? '<null>' : String(v))
const tsv = (v: unknown): string => (v === null ? '' : String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' '))

function copy(text: string): void {
  void navigator.clipboard.writeText(text)
}

function copyCell(): void {
  const r = res.value
  if (!r || !sel.value) return
  const v = r.rows[sel.value.r]?.[sel.value.c]
  copy(v === null ? 'NULL' : String(v))
}

function copyRow(r: number): void {
  const row = res.value?.rows[r]
  if (row) copy(row.map(tsv).join('\t'))
}

function copyAll(): void {
  const r = res.value
  if (!r) return
  copy([r.columns.join('\t'), ...r.rows.map((row) => row.map(tsv).join('\t'))].join('\n'))
}

function cellMenu(e: MouseEvent, r: number, c: number): void {
  sel.value = { r, c }
  openMenu(e, [
    { label: '값 복사', action: copyCell },
    { label: '행 복사 (탭 구분)', action: () => copyRow(r) },
    { label: `열 이름 복사 (${res.value?.columns[c]})`, action: () => copy(res.value?.columns[c] ?? '') },
    { label: '전체 복사 (엑셀에 붙여넣기)', sep: true, action: copyAll }
  ])
}

function onKey(e: KeyboardEvent): void {
  const r = res.value
  if (!r || !sel.value) return
  const s = sel.value
  if (e.ctrlKey && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    copyCell()
    return
  }
  const move: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
  const d = move[e.key]
  if (!d) return
  e.preventDefault()
  sel.value = { r: Math.max(0, Math.min(r.rows.length - 1, s.r + d[0])), c: Math.max(0, Math.min(r.columns.length - 1, s.c + d[1])) }
  const el = scroller.value
  if (el) {
    const top = sel.value.r * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H * 2 > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H * 2 - el.clientHeight
  }
}

/* column resize */
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

/* panel height */
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
  if (!r.columns.length) return `${(r.affected ?? 0).toLocaleString()}행 변경됨 · ${r.ms}ms`
  return `${r.rows.length.toLocaleString()}행${r.more ? ` (더 있음 · 처음 ${r.rows.length.toLocaleString()}행만 가져옴)` : ''} · ${r.ms}ms`
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
          :class="{ on: i === rs.active, err: it.error }"
          :title="it.sql"
          @click="rs.active = i"
        >
          {{ tabLabel(it, i) }}
        </button>
      </div>
      <span class="status" :class="{ err: item?.error }">{{ status }}</span>
      <span class="grow" />
      <button v-if="res?.columns.length" class="icon-btn" title="전체 복사 (탭 구분, 엑셀에 붙여넣기)" @click="copyAll"><Icon name="file" :size="13" /></button>
      <button class="icon-btn" title="결과 닫기" @click="delete db.results[path]"><Icon name="x" :size="13" /></button>
    </div>

    <div v-if="item?.error" class="error">
      <div class="emsg">{{ item.error }}</div>
      <div class="esql">{{ item.sql }}</div>
    </div>
    <div v-else-if="rs.running && !res" class="note">실행 중…</div>
    <div v-else-if="res && !res.columns.length" class="note">{{ status }}</div>
    <div v-else-if="res" ref="scroller" class="grid" tabindex="0" @scroll="onScroll" @keydown="onKey">
      <div class="inner" :style="{ width: totalW + 'px', height: (res.rows.length + 1) * ROW_H + 'px' }">
        <div class="hrow" :style="{ width: totalW + 'px' }">
          <div class="rn" />
          <div v-for="(col, c) in res.columns" :key="c" class="hc" :style="{ width: widths[c] + 'px' }" :title="col">
            {{ col }}
            <span class="rs" @mousedown="startResize($event, c)" />
          </div>
        </div>
        <div v-for="v in visible" :key="v.r" class="drow" :class="{ odd: v.r % 2 }" :style="{ top: (v.r + 1) * ROW_H + 'px', width: totalW + 'px' }">
          <div class="rn">{{ v.r + 1 }}</div>
          <div
            v-for="(val, c) in v.row"
            :key="c"
            class="dc"
            :class="{ nul: val === null, num: typeof val === 'number' || (typeof val === 'string' && NUM.test(val)), sel: sel?.r === v.r && sel?.c === c }"
            :style="{ width: widths[c] + 'px' }"
            :title="val !== null && String(val).length > 40 ? String(val).slice(0, 2000) : undefined"
            @mousedown="sel = { r: v.r, c }"
            @dblclick="copyCell"
            @contextmenu="cellMenu($event, v.r, c)"
          >
            {{ show(val) }}
          </div>
        </div>
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
.status {
  color: var(--text-dim);
  white-space: nowrap;
}
.status.err {
  color: var(--red);
}
.grow {
  flex: 1;
}
.icon-btn {
  width: 24px;
  height: 22px;
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
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
</style>
