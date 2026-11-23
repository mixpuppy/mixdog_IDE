<script setup lang="ts">
/**
 * IntelliJ-style "Git Branches" popup: search, quick actions (update / commit / push /
 * new branch / checkout revision), recent / local / remote branches, and a per-branch
 * submenu (checkout, new branch from, compare, merge, MR, rename, delete).
 */
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../Icon.vue'
import {
  git, branchPopup, refresh, pull, push, newBranch, checkout, merge, deleteBranch, renameBranch,
  openMergeRequest, compareWithCurrent, checkoutRevision, recentBranches, showGitView, select, WIP, type RefInfo
} from '../../git'
import { store } from '../../store'

interface Act {
  label: string
  run: () => unknown
  danger?: boolean
  sep?: boolean
}
type Row =
  | { type: 'head'; label: string }
  | { type: 'action'; label: string; icon: string; run: () => unknown }
  | { type: 'branch'; ref: RefInfo; section: string }

const el = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const recent = ref<string[]>([])
const active = ref(0)
/** index (in rows) of the branch whose submenu is open */
const subFor = ref<number | null>(null)
const subActive = ref(0)
const subY = ref(0)

const cur = computed(() => git.status?.branch ?? null)
const match = (s: string): boolean => !query.value || s.toLowerCase().includes(query.value.toLowerCase())

const rows = computed<Row[]>(() => {
  const list: Row[] = []
  const acts: Row[] = [
    { type: 'action', label: '프로젝트 업데이트 (Pull)', icon: '⇣', run: () => pull() },
    { type: 'action', label: '커밋…', icon: '✓', run: () => { showGitView(); select(WIP) } },
    { type: 'action', label: '푸시…', icon: '⇡', run: () => push() },
    { type: 'action', label: '새 브랜치…', icon: '+', run: () => newBranch() },
    { type: 'action', label: '태그 또는 리비전 체크아웃…', icon: '#', run: () => checkoutRevision() }
  ]
  list.push(...acts.filter((a) => a.type === 'action' && match(a.label)))

  const locals = git.refs.filter((r) => r.kind === 'local')
  const recentRefs = recent.value
    .map((n) => locals.find((r) => r.name === n))
    .filter((r): r is RefInfo => !!r && match(r.name))
    .slice(0, 5)
  if (recentRefs.length) {
    list.push({ type: 'head', label: '최근' })
    for (const r of recentRefs) list.push({ type: 'branch', ref: r, section: 'recent' })
  }
  const loc = locals.filter((r) => match(r.name))
  if (loc.length) {
    list.push({ type: 'head', label: '로컬' })
    for (const r of loc) list.push({ type: 'branch', ref: r, section: 'local' })
  }
  const rem = git.refs.filter((r) => r.kind === 'remote' && match(r.name))
  if (rem.length) {
    list.push({ type: 'head', label: '원격' })
    for (const r of rem) list.push({ type: 'branch', ref: r, section: 'remote' })
  }
  return list
})
const selectable = computed(() => rows.value.map((r, i) => (r.type === 'head' ? -1 : i)).filter((i) => i >= 0))

function subActions(r: RefInfo): Act[] {
  const c = cur.value ?? 'HEAD'
  if (r.kind === 'local' && r.current) {
    return [
      { label: `'${r.name}' 에서 새 브랜치…`, run: () => newBranch(r.name) },
      { label: '업데이트 (Pull)', run: () => pull() },
      { label: '푸시…', run: () => push() },
      { label: 'MR 만들기 (GitLab)…', run: () => openMergeRequest(r.name), sep: true },
      { label: '이름 변경…', run: () => renameBranch(r.name), sep: true }
    ]
  }
  if (r.kind === 'local') {
    return [
      { label: '체크아웃', run: () => checkout(r.name) },
      { label: `'${r.name}' 에서 새 브랜치…`, run: () => newBranch(r.name) },
      { label: `'${c}' 와(과) 비교`, run: () => compareWithCurrent(r.name), sep: true },
      { label: `'${r.name}' 을(를) '${c}' 에 병합`, run: () => merge(r.name) },
      ...(r.upstream ? [{ label: 'MR 만들기 (GitLab)…', run: () => openMergeRequest(r.name), sep: true }] : []),
      { label: '이름 변경…', run: () => renameBranch(r.name), sep: true },
      { label: '삭제', run: () => deleteBranch(r.name), danger: true }
    ]
  }
  const short = r.name.slice(r.name.indexOf('/') + 1)
  return [
    { label: '체크아웃', run: () => checkout(r.name) },
    { label: `'${r.name}' 에서 새 브랜치…`, run: () => newBranch(r.name) },
    { label: `'${c}' 와(과) 비교`, run: () => compareWithCurrent(r.name), sep: true },
    { label: `'${r.name}' 을(를) '${c}' 에 병합`, run: () => merge(r.name) },
    ...(cur.value ? [{ label: `MR 만들기: ${cur.value} → ${short}…`, run: () => openMergeRequest(cur.value!, short), sep: true }] : [])
  ]
}

const subList = computed(() => {
  const r = subFor.value !== null ? rows.value[subFor.value] : null
  return r && r.type === 'branch' ? subActions(r.ref) : []
})

function close(): void {
  branchPopup.open = false
}

function run(fn: () => unknown): void {
  close()
  fn()
}

function openSub(i: number, rowEl?: HTMLElement | null): void {
  subFor.value = i
  subActive.value = 0
  const target = rowEl ?? el.value?.querySelector<HTMLElement>(`[data-row="${i}"]`)
  const box = el.value?.getBoundingClientRect()
  const r = target?.getBoundingClientRect()
  subY.value = r && box ? r.top - box.top - 5 : 0
}

function activate(i: number, rowEl?: HTMLElement): void {
  const r = rows.value[i]
  active.value = i
  if (r.type === 'action') run(r.run)
  else if (r.type === 'branch') openSub(i, rowEl)
}

function move(d: number): void {
  const s = selectable.value
  if (!s.length) return
  const pos = s.indexOf(active.value)
  active.value = s[(pos + d + s.length) % s.length]
  subFor.value = null
  nextTick(() => el.value?.querySelector(`[data-row="${active.value}"]`)?.scrollIntoView({ block: 'nearest' }))
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    if (subFor.value !== null) subFor.value = null
    else close()
    return
  }
  if (subFor.value !== null) {
    const n = subList.value.length
    if (e.key === 'ArrowDown') subActive.value = (subActive.value + 1) % n
    else if (e.key === 'ArrowUp') subActive.value = (subActive.value - 1 + n) % n
    else if (e.key === 'ArrowLeft') subFor.value = null
    else if (e.key === 'Enter') run(subList.value[subActive.value].run)
    else return
    e.preventDefault()
    return
  }
  if (e.key === 'ArrowDown') move(1)
  else if (e.key === 'ArrowUp') move(-1)
  else if (e.key === 'Enter' || (e.key === 'ArrowRight' && rows.value[active.value]?.type === 'branch')) activate(active.value)
  else return
  e.preventDefault()
}

watch(query, () => {
  subFor.value = null
  active.value = selectable.value[0] ?? 0
})

const away = (e: MouseEvent): void => {
  if (!el.value?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-branch-trigger]')) close()
}
onMounted(async () => {
  window.addEventListener('mousedown', away, true)
  input.value?.focus()
  refresh()
  if (store.project) recent.value = await recentBranches().catch(() => [])
  // start on the first branch row so ↓/Enter go straight to branches, like IntelliJ
  active.value = rows.value.findIndex((r) => r.type === 'branch')
  if (active.value < 0) active.value = selectable.value[0] ?? 0
})
onBeforeUnmount(() => window.removeEventListener('mousedown', away, true))

const left = computed(() => Math.max(8, Math.min(branchPopup.x, window.innerWidth - 640)))
</script>

<template>
  <div ref="el" class="bp" :style="{ left: left + 'px', top: branchPopup.y + 'px' }" @keydown="onKey">
    <div class="search">
      <Icon name="search" :size="14" />
      <input ref="input" v-model="query" placeholder="브랜치 및 동작 검색" spellcheck="false" />
    </div>
    <div class="list">
      <template v-for="(r, i) in rows" :key="i">
        <div v-if="r.type === 'head'" class="head">{{ r.label }}</div>
        <div
          v-else-if="r.type === 'action'"
          class="row act"
          :class="{ on: active === i }"
          :data-row="i"
          @mouseenter="active = i; subFor = null"
          @click="activate(i)"
        >
          <span class="ico">{{ r.icon }}</span>{{ r.label }}
        </div>
        <div
          v-else
          class="row br"
          :class="{ on: active === i, open: subFor === i }"
          :data-row="i"
          @mouseenter="active = i; openSub(i, $event.currentTarget as HTMLElement)"
          @click="activate(i, $event.currentTarget as HTMLElement)"
          @dblclick="!r.ref.current && run(() => checkout(r.ref.name))"
        >
          <span class="ico" :class="{ cur: r.ref.current }">{{ r.ref.current ? '◆' : r.ref.kind === 'remote' ? '☁' : '⑂' }}</span>
          <span class="name" :class="{ current: r.ref.current }">{{ r.ref.name }}</span>
          <span v-if="r.ref.kind === 'local' && r.ref.ahead" class="ab up" title="푸시할 커밋">↑{{ r.ref.ahead }}</span>
          <span v-if="r.ref.kind === 'local' && r.ref.behind" class="ab down" title="받을 커밋">↓{{ r.ref.behind }}</span>
          <span v-if="r.ref.upstream" class="up-name">{{ r.ref.upstream }}</span>
          <span class="chev">›</span>
        </div>
      </template>
      <div v-if="!rows.length" class="none">일치하는 항목이 없습니다</div>
    </div>

    <div v-if="subFor !== null" class="sub" :style="{ top: subY + 'px' }" @mouseenter="active = subFor!">
      <template v-for="(a, j) in subList" :key="j">
        <div v-if="a.sep" class="sep" />
        <div class="row" :class="{ on: subActive === j, danger: a.danger }" @mouseenter="subActive = j" @click="run(a.run)">{{ a.label }}</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.bp {
  position: fixed;
  z-index: 250;
  width: 380px;
  max-height: min(560px, calc(100vh - 80px));
  display: flex;
  flex-direction: column;
  background: var(--elevated);
  border-radius: 10px;
  box-shadow: var(--shadow);
  font-size: 13px;
}
.search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 8px;
  padding: 0 9px;
  height: 30px;
  border-radius: 7px;
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
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 5px 6px;
}
.head {
  padding: 8px 10px 3px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-faint);
}
.row {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 27px;
  padding: 0 9px;
  border-radius: 6px;
  white-space: nowrap;
}
.row.on,
.row.open {
  background: var(--accent);
  color: #fff;
}
.row.on .up-name,
.row.on .ab,
.row.open .up-name,
.row.open .ab,
.row.on .ico,
.row.open .ico {
  color: #fff;
}
.ico {
  width: 16px;
  flex-shrink: 0;
  text-align: center;
  color: var(--text-dim);
}
.ico.cur {
  color: #ff9f0a;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.name.current {
  font-weight: 700;
}
.ab {
  font-size: 11px;
  font-weight: 700;
}
.ab.up {
  color: var(--green);
}
.ab.down {
  color: #ff9f0a;
}
.up-name {
  margin-left: auto;
  padding-left: 10px;
  font-size: 11.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
}
.chev {
  flex-shrink: 0;
  margin-left: auto;
  padding-left: 6px;
  opacity: 0.6;
}
.up-name + .chev {
  margin-left: 0;
}
.none {
  padding: 14px;
  color: var(--text-faint);
}
.sub {
  position: absolute;
  left: calc(100% + 4px);
  min-width: 250px;
  padding: 5px;
  background: var(--elevated);
  border-radius: 9px;
  box-shadow: var(--shadow);
}
.sub .row.danger {
  color: var(--red);
}
.sub .row.danger.on {
  background: var(--red);
  color: #fff;
}
.sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-strong);
}
</style>
