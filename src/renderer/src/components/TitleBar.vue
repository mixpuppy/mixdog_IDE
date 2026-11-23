<script setup lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import { store, openFolder, openFolderInNewWindow, openRecent } from '../store'
import { openMenu, type MenuItem } from '../ui'
import { ide } from '../ide'
import { run } from '../commands'
import { ai } from '../ai'
import { git, showGitView, toggleBranchPopup, branchPopup } from '../git'

const api = window.api

/** Project button: open here / in a new window, recent projects (IntelliJ "File > Open / Recent"). */
function projectMenu(e: MouseEvent): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const recent = store.recent.filter((p) => p.path !== store.project?.path).slice(0, 8)
  const items: MenuItem[] = [
    { label: '폴더 열기…', action: () => openFolder() },
    { label: '새 창에서 폴더 열기…', action: () => openFolderInNewWindow() },
    { label: '새 창 (빈 창)', action: () => api.newWindow(null) },
    ...(recent.length ? [{ label: '최근 프로젝트', header: true, sep: true } as MenuItem] : []),
    ...recent.map((p) => ({ label: p.name, hint: p.path, action: () => openRecent(p) })),
    ...(recent.length ? [{ label: '최근 프로젝트를 새 창에서', header: true, sep: true } as MenuItem] : []),
    ...recent.slice(0, 4).map((p) => ({ label: `↗ ${p.name}`, hint: p.path, action: () => openRecent(p, true) }))
  ]
  openMenu(new MouseEvent('contextmenu', { clientX: r.left, clientY: r.bottom + 4 }), items)
}

const title = computed(() => {
  const tab = store.tabs.find((t) => t.path === store.activePath)
  return tab ? tab.name : store.project?.name ?? 'mixdog IDE'
})

const initial = computed(() => (store.project?.name ?? 'M').charAt(0).toUpperCase())

const tomcatLabel = computed(() => {
  const t = ide.info?.tomcat
  return t ? `Tomcat ${t.version}` : 'Tomcat 설정'
})
const busy = computed(() => ide.building || ide.tomcat !== 'stopped')

/** ▶ with no Tomcat configured opens the run configuration instead. */
function start(debug: boolean): void {
  if (!store.project) return
  if (!ide.info?.settings.run.tomcatHome) run('settings.run')
  else run(debug ? 'run.debug' : 'run.start')
}
</script>

<template>
  <header class="titlebar drag" @dblclick.self="api.window.toggleMaximize()">
    <!-- macOS traffic lights -->
    <div class="traffic no-drag" :class="{ blurred: !store.windowFocused }">
      <button class="tl close" title="닫기" @click="api.window.close()">
        <svg viewBox="0 0 12 12"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" /></svg>
      </button>
      <button class="tl min" title="최소화" @click="api.window.minimize()">
        <svg viewBox="0 0 12 12"><path d="M3 6h6" /></svg>
      </button>
      <button class="tl max" title="확대/축소" @click="api.window.toggleMaximize()">
        <svg viewBox="0 0 12 12"><path d="M3.6 8.4V4.6l3.8 3.8zM8.4 3.6v3.8L4.6 3.6z" class="fill" /></svg>
      </button>
    </div>

    <div class="left no-drag">
      <button class="pill-btn project" title="프로젝트 · 창" @click="projectMenu">
        <span class="badge">{{ initial }}</span>
        <span>{{ store.project?.name ?? '프로젝트 열기' }}</span>
        <Icon name="chevronDown" :size="11" class="dim" />
      </button>
      <button v-if="store.project" class="pill-btn" :class="{ pressed: branchPopup.open }" data-branch-trigger title="Git 브랜치 (Ctrl+Shift+`)" @click="git.status ? toggleBranchPopup($event) : showGitView()">
        <Icon name="branch" :size="14" class="dim" />
        <span :class="{ dim: !git.status }">{{ git.status ? (git.status.detached ? 'HEAD (detached)' : git.status.branch) : 'Git 없음' }}</span>
      </button>
    </div>

    <div class="title" @dblclick="api.window.toggleMaximize()">{{ title }}</div>

    <div class="right no-drag">
      <template v-if="store.project">
        <button class="icon-btn" title="빌드 (Ctrl+F9)" :disabled="ide.building" @click="run('build.run')">
          <Icon name="hammer" :size="15" />
        </button>
        <button class="pill-btn run-config" title="실행 구성" @click="run('settings.run')">
          <span class="state" :class="ide.tomcat" />
          <Icon name="server" :size="14" class="tomcat" />
          <span>{{ tomcatLabel }}</span>
          <Icon name="chevronDown" :size="11" class="dim" />
        </button>
        <button class="icon-btn run" title="실행 (Shift+F10)" :disabled="busy" @click="start(false)"><Icon name="play" :size="14" /></button>
        <button class="icon-btn debug" title="디버그 (Shift+F9)" :disabled="busy" @click="start(true)"><Icon name="bug" :size="16" /></button>
        <button class="icon-btn stop" :class="{ live: busy }" title="중지 (Ctrl+F2)" :disabled="!busy" @click="run('run.stop')">
          <Icon name="stop" :size="12" />
        </button>
        <span class="sep" />
      </template>
      <button class="ai-btn" :class="{ on: ai.visible }" title="Claude (Ctrl+Shift+A)" @click="ai.visible = !ai.visible">
        ✦ <span>Claude</span><span v-if="ai.tabs.some((t) => t.exited === null)" class="dot" /><span v-if="ai.tabs.length > 1" class="count">{{ ai.tabs.length }}</span>
      </button>
      <button class="icon-btn" title="검색 (Shift 두 번, 준비 중)"><Icon name="search" /></button>
      <button class="icon-btn" title="프로젝트 설정 (Ctrl+Alt+Shift+S)" @click="store.project && run('settings.project')"><Icon name="settings" /></button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: var(--titlebar-h);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px 0 14px;
  background: var(--chrome);
  border-bottom: 1px solid var(--border);
  position: relative;
  flex-shrink: 0;
}

.traffic {
  display: flex;
  gap: 8px;
  margin-right: 8px;
}
.tl {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.18);
}
.tl svg {
  width: 8px;
  height: 8px;
  stroke: rgba(0, 0, 0, 0.55);
  stroke-width: 1.3;
  stroke-linecap: round;
  fill: none;
  opacity: 0;
}
.tl svg .fill {
  fill: rgba(0, 0, 0, 0.55);
  stroke: none;
}
.traffic:hover .tl svg {
  opacity: 1;
}
.tl.close { background: var(--tl-close); }
.tl.min { background: var(--tl-min); }
.tl.max { background: var(--tl-max); }
.traffic.blurred:not(:hover) .tl {
  background: var(--tl-idle);
}

.left,
.right {
  display: flex;
  align-items: center;
  gap: 2px;
  z-index: 1;
}
.right {
  margin-left: auto;
}

.badge {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #5e5ce6, #0a84ff);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
}
.project {
  font-weight: 600;
}
.dim {
  color: var(--text-dim);
}

.title {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  font-weight: 600;
  font-size: 13px;
  color: var(--text-dim);
  max-width: 34%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.run-config {
  border: 1px solid var(--border);
  margin-right: 4px;
}
.tomcat {
  color: #f5a623;
}
.run {
  color: var(--green);
}
.icon-btn:disabled {
  opacity: 0.35;
  pointer-events: none;
}
.ai-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  margin-right: 4px;
  border-radius: 13px;
  border: 1px solid var(--border-strong);
  color: #d97757;
  font-weight: 600;
}
.ai-btn span {
  color: var(--text);
}
.ai-btn:hover {
  background: var(--hover);
}
.ai-btn.on {
  background: rgba(217, 119, 87, 0.16);
  border-color: rgba(217, 119, 87, 0.5);
}
.ai-btn .count {
  font-size: 10.5px;
  color: var(--text-dim) !important;
}
.ai-btn .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--green);
}
.stop.live {
  color: var(--red);
}
.state {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}
.state.starting {
  background: #ff9f0a;
}
.state.running {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
}
.debug {
  color: #64d2ff;
}
.sep {
  width: 1px;
  height: 18px;
  background: var(--border-strong);
  margin: 0 6px;
}
.pill-btn.pressed {
  background: var(--active);
}
</style>
