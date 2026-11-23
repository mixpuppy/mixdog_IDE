<script setup lang="ts">
/** Commit graph (GitKraken style): lanes, ref pills, subject, author, date. */
import { computed, ref, watch, nextTick } from 'vue'
import { git, WIP, select, loadMore, refsAt, ago, laneColor, checkout, newBranch, reset, revert, cherryPick, merge, deleteBranch, type GraphRow, type RefInfo } from '../../git'
import { openMenu, type MenuItem } from '../../ui'
import { toast } from '../../ide'

const H = 28
const LW = 14
const x = (i: number): number => 11 + i * LW
const mid = H / 2

/* ---- column widths (drag the header edges; remembered) ---- */
const COLS_KEY = 'mixdog.gitCols'
const cols = ref<{ graph: number; author: number; date: number; hash: number }>({ graph: 160, author: 120, date: 82, hash: 64 })
try {
  Object.assign(cols.value, JSON.parse(localStorage.getItem(COLS_KEY) ?? '{}'))
} catch {
  /* defaults */
}
/** graph column: as wide as the lanes need, but never more than the (adjustable) maximum */
const graphW = computed(() => Math.min(cols.value.graph, x(Math.max(git.lanes, 1) - 1) + 14))
const colVars = computed(() => ({ '--w-author': cols.value.author + 'px', '--w-date': cols.value.date + 'px', '--w-hash': cols.value.hash + 'px' }))

/** `edge` = the column whose border is dragged; graph grows to the right, the others to the left */
function resizeCol(e: MouseEvent, edge: 'graph' | 'author' | 'date' | 'hash'): void {
  const sx = e.clientX
  const start = edge === 'graph' ? graphW.value : cols.value[edge]
  const MIN = { graph: 30, author: 50, date: 50, hash: 40 }[edge]
  const move = (ev: MouseEvent): void => {
    const d = ev.clientX - sx
    cols.value[edge] = Math.round(Math.max(MIN, Math.min(600, start + (edge === 'graph' ? d : -d))))
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(cols.value))
    } catch {
      /* ignore */
    }
  }
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
const headRow = computed(() => git.rows.find((r) => r.commit.hash === git.head))
const wipCount = computed(() => {
  const s = git.status
  return s ? s.staged.length + s.unstaged.length + s.conflicts.length : 0
})

function curve(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`
  const my = (y1 + y2) / 2
  return `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`
}

function paths(r: GraphRow): { d: string; c: string }[] {
  const out: { d: string; c: string }[] = []
  r.before.forEach((h, i) => {
    if (h && h !== r.commit.hash) out.push({ d: `M${x(i)} 0L${x(i)} ${H}`, c: laneColor(i) })
  })
  for (const i of r.up) out.push({ d: curve(x(i), 0, x(r.col), mid), c: laneColor(i) })
  r.down.forEach((j, n) => out.push({ d: curve(x(r.col), mid, x(j), H), c: laneColor(n === 0 ? j : j) }))
  return out
}

function pillLabel(r: RefInfo): string {
  return r.kind === 'tag' ? `🏷 ${r.name}` : r.name
}

function rowMenu(e: MouseEvent, row: GraphRow): void {
  const h = row.commit.hash
  const short = h.slice(0, 7)
  const locals = refsAt(h).filter((r) => r.kind === 'local' && !r.current)
  const items: MenuItem[] = [
    ...locals.map((r) => ({ label: `${r.name} 로 체크아웃`, action: () => checkout(r.name) })),
    { label: `여기서 새 브랜치…`, action: () => newBranch(h) },
    { label: `이 커밋으로 체크아웃 (detached)`, action: () => checkout(h) },
    ...locals.map((r) => ({ label: `${r.name} 을(를) 현재 브랜치에 병합`, action: () => merge(r.name) })),
    { label: '현재 브랜치에 체리픽', action: () => cherryPick(h), sep: true },
    { label: '이 커밋 되돌리기 (revert)', action: () => revert(h) },
    { label: `여기로 Reset — soft`, action: () => reset(h, 'soft'), sep: true },
    { label: `여기로 Reset — mixed`, action: () => reset(h, 'mixed') },
    { label: `여기로 Reset — hard`, action: () => reset(h, 'hard'), danger: true },
    ...locals.map((r) => ({ label: `브랜치 ${r.name} 삭제`, action: () => deleteBranch(r.name), danger: true })),
    {
      label: `커밋 해시 복사 (${short})`,
      sep: true,
      action: () => navigator.clipboard.writeText(h).then(() => toast('복사됨', 'ok'))
    }
  ]
  openMenu(e, items)
}

function pillMenu(e: MouseEvent, r: RefInfo): void {
  if (r.kind === 'tag') return
  openMenu(e, [
    { label: `${r.name} 체크아웃`, action: () => checkout(r.name), disabled: r.current },
    { label: `${r.name} 을(를) 현재 브랜치에 병합`, action: () => merge(r.name), disabled: r.current },
    { label: `${r.name} 에서 새 브랜치…`, action: () => newBranch(r.name) },
    ...(r.kind === 'local' ? [{ label: `브랜치 ${r.name} 삭제`, action: () => deleteBranch(r.name), danger: true, disabled: r.current, sep: true }] : [])
  ])
}

/* keep the selected row visible (e.g. picked from the branch list) */
const list = ref<HTMLElement | null>(null)
watch(
  () => git.selected,
  async (h) => {
    await nextTick()
    list.value?.querySelector(`[data-hash="${h}"]`)?.scrollIntoView({ block: 'nearest' })
  }
)

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const ids = [WIP, ...git.rows.map((r) => r.commit.hash)]
  const i = ids.indexOf(git.selected)
  const n = Math.min(ids.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))
  if (n !== i) select(ids[n])
}
</script>

<template>
  <div ref="list" class="graph" tabindex="0" :style="colVars" @keydown="onKey">
    <div class="head-row">
      <span class="c-graph hc" :style="{ width: graphW + 'px' }"><i class="rz right" title="드래그: 그래프 폭" @mousedown.prevent.stop="resizeCol($event, 'graph')" /></span>
      <span class="c-msg">커밋 메시지</span>
      <span class="c-author hc"><i class="rz left" title="드래그: 폭 조절" @mousedown.prevent.stop="resizeCol($event, 'author')" />작성자</span>
      <span class="c-date hc"><i class="rz left" title="드래그: 폭 조절" @mousedown.prevent.stop="resizeCol($event, 'date')" />날짜</span>
      <span class="c-hash hc"><i class="rz left" title="드래그: 폭 조절" @mousedown.prevent.stop="resizeCol($event, 'hash')" />해시</span>
    </div>

    <div class="row wip" :class="{ on: git.selected === WIP }" :data-hash="WIP" @click="select(WIP)">
      <svg class="c-graph" :width="graphW" :height="H">
        <path v-if="headRow" :d="`M${x(headRow.col)} ${mid}L${x(headRow.col)} ${H}`" stroke="var(--text-faint)" stroke-dasharray="3 3" stroke-width="2" fill="none" />
        <circle :cx="x(headRow?.col ?? 0)" :cy="mid" r="6" fill="var(--surface)" stroke="var(--text-faint)" stroke-width="2" stroke-dasharray="3 2" />
      </svg>
      <span class="c-msg">
        <span class="wip-label">// 작업 중</span>
        <span v-if="wipCount" class="count">{{ wipCount }}개 파일 변경</span>
        <span v-else class="dim">변경 없음</span>
      </span>
      <span class="c-author" />
      <span class="c-date" />
      <span class="c-hash" />
    </div>

    <div
      v-for="r in git.rows"
      :key="r.commit.hash"
      class="row"
      :class="{ on: git.selected === r.commit.hash, head: r.commit.hash === git.head }"
      :data-hash="r.commit.hash"
      @click="select(r.commit.hash)"
      @contextmenu="rowMenu($event, r)"
    >
      <svg class="c-graph" :width="graphW" :height="H">
        <path v-for="(p, i) in paths(r)" :key="i" :d="p.d" :stroke="p.c" stroke-width="2" fill="none" />
        <circle
          :cx="x(r.col)"
          :cy="mid"
          :r="r.commit.parents.length > 1 ? 4 : 5.5"
          :fill="r.commit.parents.length > 1 ? 'var(--surface)' : laneColor(r.col)"
          :stroke="laneColor(r.col)"
          stroke-width="2"
        />
      </svg>
      <span class="c-msg">
        <span
          v-for="ref in refsAt(r.commit.hash)"
          :key="ref.ref"
          class="pill"
          :class="[ref.kind, { current: ref.current }]"
          :style="{ '--lane': laneColor(r.col) }"
          :title="ref.upstream ? `${ref.name} → ${ref.upstream}` : ref.name"
          @dblclick.stop="ref.kind !== 'tag' && checkout(ref.name)"
          @contextmenu.stop="pillMenu($event, ref)"
        >{{ pillLabel(ref) }}</span>
        <span v-if="git.outgoing.has(r.commit.hash)" class="flow out" title="아직 푸시하지 않은 커밋">↑</span>
        <span v-else-if="git.incoming.has(r.commit.hash)" class="flow in" :title="`${git.compare} 에만 있는 커밋 (받을 것)`">↓</span>
        <span class="subject" :class="{ incoming: git.incoming.has(r.commit.hash) }">{{ r.commit.subject }}</span>
      </span>
      <span class="c-author" :title="r.commit.email">{{ r.commit.author }}</span>
      <span class="c-date" :title="new Date(r.commit.time).toLocaleString()">{{ ago(r.commit.time) }}</span>
      <span class="c-hash">{{ r.commit.hash.slice(0, 7) }}</span>
    </div>

    <button v-if="git.more" class="more" @click="loadMore">이전 커밋 더 보기…</button>
    <div v-if="!git.rows.length && !git.loading" class="empty">아직 커밋이 없습니다</div>
  </div>
</template>

<style scoped>
.graph {
  flex: 1;
  min-height: 0;
  overflow: auto;
  outline: none;
  font-size: 12.5px;
}
.head-row,
.row {
  display: flex;
  align-items: center;
  height: 28px;
  min-width: 0;
}
.head-row {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 26px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 600;
}
.head-row .c-graph {
  padding-left: 10px;
}
.hc {
  position: relative;
  align-self: stretch;
  display: flex;
  align-items: center;
}
/* header cells must not clip their border handles (body cells keep ellipsis clipping) */
.head-row .hc {
  overflow: visible;
}
.head-row .c-author,
.head-row .c-date,
.head-row .c-hash {
  padding-left: 8px;
}
/* gap after the graph column border, same in the header and the rows so text stays aligned */
.c-msg {
  padding-left: 10px;
}
/* column border handle */
.rz {
  position: absolute;
  top: 3px;
  bottom: 3px;
  width: 9px;
  cursor: col-resize;
  z-index: 3;
}
.rz.left {
  left: -6px;
}
.rz.right {
  right: -5px;
}
.rz::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 2px;
  bottom: 2px;
  width: 1px;
  background: var(--border-strong);
}
.rz:hover::after {
  width: 3px;
  left: 3px;
  background: var(--accent);
}
.row:hover {
  background: var(--hover);
}
.row.on {
  background: var(--accent-soft);
}
.c-graph {
  flex-shrink: 0;
  overflow: hidden;
}
.c-msg {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  white-space: nowrap;
  /* margin (not padding) so long ref pills are clipped before the author column */
  margin-right: 12px;
}
.subject {
  overflow: hidden;
  text-overflow: ellipsis;
}
.row.head .subject {
  font-weight: 600;
}
.c-author {
  width: var(--w-author, 120px);
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
}
.c-date {
  width: var(--w-date, 82px);
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  color: var(--text-dim);
  white-space: nowrap;
}
.c-hash {
  width: var(--w-hash, 64px);
  overflow: hidden;
  flex-shrink: 0;
  font-family: var(--font-code);
  font-size: 11.5px;
  color: var(--text-faint);
}
.pill {
  flex-shrink: 0;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 1px 7px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--lane);
  color: var(--lane);
  background: color-mix(in srgb, var(--lane) 12%, transparent);
}
.pill.local.current {
  background: var(--lane);
  color: #fff;
}
.pill.remote {
  border-style: dashed;
}
.pill.tag {
  border-color: var(--text-faint);
  color: var(--text-dim);
  background: var(--surface-2);
}
.flow {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 800;
}
.flow.out {
  color: var(--green);
  background: color-mix(in srgb, var(--green) 18%, transparent);
}
.flow.in {
  color: #ff9f0a;
  background: #ff9f0a2e;
}
.subject.incoming {
  color: var(--text-dim);
}
.wip-label {
  font-style: italic;
  color: var(--text-dim);
}
.count {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 9px;
  background: #ff9f0a33;
  color: #ff9f0a;
}
.dim {
  color: var(--text-faint);
  font-size: 11.5px;
}
.more {
  margin: 10px 14px;
  color: var(--accent);
}
.empty {
  padding: 30px;
  text-align: center;
  color: var(--text-faint);
}
</style>
