<script setup lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import FileIcon from './FileIcon.vue'
import { store, closeTab, closeOthers, splitTab, moveTab, unsplit, relativeParts } from '../store'
import { openMenu, type MenuItem } from '../ui'
import { toast } from '../ide'

const props = defineProps<{ groupId: number }>()
const group = computed(() => store.groups.find((g) => g.id === props.groupId))
const gi = (): number => store.groups.findIndex((g) => g.id === props.groupId)
const crumbs = computed(() => (group.value?.activePath ? relativeParts(group.value.activePath) : []))

const TAB_TYPE = 'application/x-mixdog-tab'

function activate(path: string): void {
  if (!group.value) return
  group.value.activePath = path
  store.activeGroup = gi()
  store.selectedPath = path
}

function reveal(path: string): void {
  void window.api.reveal(path).catch((err: Error) => toast(err.message, 'error'))
}

/** compiled .class of a Java / Kotlin source in Explorer (Maven target/classes, Gradle build/classes ...) */
async function revealClass(path: string): Promise<void> {
  const r = await window.api.classFile(path).catch(() => null)
  if (!r) return toast('class 파일이 없습니다. 먼저 빌드(컴파일)하세요.', 'error')
  if (!r.exact) toast('이 클래스는 아직 컴파일되지 않아 패키지 폴더를 엽니다', 'info')
  void window.api.reveal(r.path)
}

function menu(e: MouseEvent, path: string): void {
  const i = gi()
  const items: MenuItem[] = [
    { label: '닫기', action: () => closeTab(path, i) },
    { label: '다른 탭 모두 닫기', action: () => closeOthers(path, i), disabled: (group.value?.tabs.length ?? 0) < 2 },
    { label: '오른쪽으로 분할', action: () => splitTab(path, 'row', i), sep: true },
    { label: '아래로 분할', action: () => splitTab(path, 'column', i) },
    { label: '오른쪽으로 옮겨서 분할', action: () => splitTab(path, 'row', i, true), disabled: (group.value?.tabs.length ?? 0) < 2 },
    ...store.groups
      .map((g, n) => ({ g, n }))
      .filter(({ n }) => n !== i)
      .map(({ n }) => ({ label: `${n + 1}번 창으로 옮기기`, action: () => moveTab(path, i, n) })),
    ...(store.groups.length > 1 ? [{ label: '분할 해제 (창 하나로 합치기)', action: () => unsplit(), sep: true }] : []),
    { label: '탐색기에서 열기', hint: '파일 위치', action: () => reveal(path), sep: true },
    ...(/\.(java|kt)$/i.test(path) ? [{ label: 'class 파일 위치 열기', hint: '컴파일 결과', action: () => revealClass(path) }] : []),
    { label: '경로 복사', action: () => void navigator.clipboard.writeText(path) }
  ]
  openMenu(e, items)
}

function dragStart(e: DragEvent, path: string): void {
  e.dataTransfer?.setData(TAB_TYPE, JSON.stringify({ path, from: gi() }))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  setTimeout(() => (store.tabDrag = { path, from: gi() }), 0)
}
</script>

<template>
  <div class="tabs-wrap">
    <div class="tabs">
      <div
        v-for="t in group?.tabs ?? []"
        :key="t.path"
        class="tab"
        :class="{ active: t.path === group?.activePath, dim: store.groups.length > 1 && gi() !== store.activeGroup }"
        :title="`${t.path} · 드래그: 창 분할 / 다른 창으로 옮기기 · 오른쪽 클릭: 분할 메뉴`"
        draggable="true"
        @click="activate(t.path)"
        @mousedown.middle.prevent="closeTab(t.path, gi())"
        @contextmenu="menu($event, t.path)"
        @dragstart="dragStart($event, t.path)"
        @dragend="store.tabDrag = null"
      >
        <FileIcon :name="t.name" />
        <span class="name">{{ t.name }}</span>
        <button class="close" :class="{ dirty: t.dirty }" title="닫기 (Ctrl+F4)" @click.stop="closeTab(t.path, gi())">
          <span class="dot" />
          <Icon name="x" :size="11" class="x" />
        </button>
      </div>
    </div>
    <div v-if="crumbs.length" class="crumbs">
      <template v-for="(c, i) in crumbs" :key="i">
        <span v-if="i > 0" class="sep">›</span>
        <span :class="{ last: i === crumbs.length - 1 }">{{ c }}</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tabs-wrap {
  flex-shrink: 0;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.tabs {
  display: flex;
  height: 36px;
  overflow-x: auto;
  overflow-y: hidden;
}
.tabs::-webkit-scrollbar {
  height: 0;
}
.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px 0 12px;
  min-width: 110px;
  max-width: 220px;
  color: var(--text-dim);
  border-right: 1px solid var(--border);
  white-space: nowrap;
}
.tab:hover {
  background: var(--hover);
}
.tab.active {
  background: var(--surface);
  color: var(--text);
}
.tab.active.dim::after {
  opacity: 0.35;
}
.tab.active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent);
}
.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.close {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
}
.close:hover {
  background: var(--active);
  color: var(--text);
}
.close .x {
  opacity: 0;
}
.tab:hover .close .x,
.tab.active .close .x {
  opacity: 1;
}
/* macOS-style unsaved indicator: dot that turns into × on hover */
.dot {
  display: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-dim);
}
.close.dirty .dot {
  display: block;
}
.close.dirty .x {
  display: none;
}
.close.dirty:hover .dot {
  display: none;
}
.close.dirty:hover .x {
  display: block;
  opacity: 1;
}
.crumbs {
  height: 26px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 14px;
  background: var(--surface);
  color: var(--text-faint);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
}
.crumbs .last {
  color: var(--text-dim);
}
.sep {
  opacity: 0.7;
}
</style>
