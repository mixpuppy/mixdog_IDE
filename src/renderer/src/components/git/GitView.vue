<script setup lang="ts">
/** GitKraken-style main view: toolbar, commit graph (or diff) and a details panel. */
import { computed, onMounted, onBeforeUnmount, watch } from 'vue'
import Icon from '../Icon.vue'
import GitGraph from './GitGraph.vue'
import GitDiff from './GitDiff.vue'
import GitWip from './GitWip.vue'
import GitCommitInfo from './GitCommitInfo.vue'
import { git, WIP, toggleBranchPopup, setScope, setCompare, refresh, fetchAll, pull, push, forcePush, newBranch, stashPush, stashAction, abort, initRepo } from '../../git'
import { store } from '../../store'
import { openMenu } from '../../ui'

const st = computed(() => git.status)
const dirty = computed(() => !!st.value && st.value.staged.length + st.value.unstaged.length > 0)
const compareRemotes = computed(() => git.refs.filter((r) => r.kind === 'remote' && r.name !== st.value?.upstream).map((r) => r.name))
const compareLocals = computed(() => git.refs.filter((r) => r.kind === 'local' && !r.current).map((r) => r.name))
const STATE: Record<string, string> = { MERGING: '병합 중', REBASING: '리베이스 중', 'CHERRY-PICKING': '체리픽 중', REVERTING: 'Revert 중' }

onMounted(() => refresh())
const onFocus = (f: boolean): void => {
  if (f && store.mainView === 'git') refresh()
}
watch(() => store.windowFocused, onFocus)

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && git.diff && !store.dialog) git.diff = null
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function pushMenu(e: MouseEvent): void {
  openMenu(e, [
    { label: '푸시', action: () => push() },
    { label: '강제 푸시 (--force-with-lease)…', action: () => forcePush(), danger: true }
  ])
}

const W_KEY = 'mixdog.gitPanelW'
let panelW = Number(localStorage.getItem(W_KEY)) || 340
const panelStyle = computed(() => ({ width: `${git.panelW}px` }))
git.panelW = panelW
function startResize(e: MouseEvent): void {
  const sx = e.clientX
  const sw = git.panelW
  const move = (ev: MouseEvent): void => {
    git.panelW = Math.min(640, Math.max(260, sw - (ev.clientX - sx)))
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
    panelW = git.panelW
    try {
      localStorage.setItem(W_KEY, String(panelW))
    } catch {
      /* ignore */
    }
  }
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
</script>

<template>
  <div class="gitview">
    <div v-if="!store.project" class="center">프로젝트를 먼저 여세요</div>
    <div v-else-if="!git.isRepo" class="center">
      <p>이 프로젝트는 Git 저장소가 아닙니다</p>
      <button class="primary-btn" @click="initRepo">Git 저장소 만들기 (git init)</button>
    </div>
    <template v-else>
      <div class="toolbar">
        <div class="branch" data-branch-trigger :title="(st?.upstream ? `추적: ${st.upstream}` : '원격 추적 브랜치 없음') + ' · 클릭: 브랜치 목록'" @click="toggleBranchPopup">
          <Icon name="branch" :size="14" />
          <b>{{ st?.detached ? 'HEAD (detached)' : st?.branch ?? '…' }}</b>
        </div>
        <div class="sep" />
        <button class="tool" :disabled="!!git.busy" :title="st?.behind ? `git pull · 받을 커밋 ${st.behind}개` : 'git pull'" @click="pull">
          <span class="ico">⇣<span v-if="st?.behind" class="badge down">{{ st.behind > 99 ? '99+' : st.behind }}</span></span><span>Pull</span>
        </button>
        <button class="tool" :disabled="!!git.busy" :title="(st?.ahead ? `git push · 올릴 커밋 ${st.ahead}개` : 'git push') + ' (오른쪽 클릭: 강제 푸시)'" @click="push()" @contextmenu="pushMenu">
          <span class="ico">⇡<span v-if="st?.ahead" class="badge up">{{ st.ahead > 99 ? '99+' : st.ahead }}</span></span><span>Push</span>
        </button>
        <button class="tool" :disabled="!!git.busy" title="git fetch --all --prune" @click="fetchAll">
          <span class="ico">⟳</span><span>Fetch</span>
        </button>
        <div class="sep" />
        <button class="tool" title="새 브랜치" @click="newBranch()">
          <Icon name="branch" :size="15" /><span>브랜치</span>
        </button>
        <button class="tool" :disabled="!dirty" title="git stash push -u" @click="stashPush">
          <span class="ico">⊟</span><span>Stash</span>
        </button>
        <button class="tool" :disabled="!git.stashes.length" title="가장 최근 스태시 꺼내기 (git stash pop)" @click="stashAction('pop', 0)">
          <span class="ico">⊞</span><span>Pop</span>
        </button>
        <div class="sep" />
        <div class="seg" title="그래프에 보일 브랜치">
          <button :class="{ on: git.scope === 'all' }" @click="setScope('all')">모든 브랜치</button>
          <button :class="{ on: git.scope === 'current' }" @click="setScope('current')">현재 브랜치</button>
        </div>
        <template v-if="git.scope === 'current'">
          <select class="cmp" :value="git.compareWith ?? ''" title="현재 브랜치와 비교할 브랜치" @change="setCompare(($event.target as HTMLSelectElement).value || null)">
            <option value="">비교: {{ st?.upstream ? `업스트림 (${st.upstream})` : '업스트림 없음' }}</option>
            <optgroup label="원격 브랜치">
              <option v-for="r in compareRemotes" :key="r" :value="r">비교: {{ r }}</option>
            </optgroup>
            <optgroup label="로컬 브랜치">
              <option v-for="r in compareLocals" :key="r" :value="r">비교: {{ r }}</option>
            </optgroup>
          </select>
          <span v-if="git.compare" class="cmp-sum" :title="`${git.compare} 기준`">
            <span class="ab up" title="내 브랜치에만 있는 커밋 (푸시할 것)">↑{{ git.compareAhead }}</span>
            <span class="ab down" title="비교 브랜치에만 있는 커밋 (받을 것)">↓{{ git.compareBehind }}</span>
          </span>
        </template>
        <div class="spacer" />
        <span v-if="git.busy" class="busy"><span class="spin" />{{ git.busy }}… <span class="prog">{{ git.progress }}</span></span>
        <button class="icon-btn" title="새로고침" @click="refresh()"><Icon name="refresh" :size="15" /></button>
      </div>

      <div v-if="st?.state" class="banner">
        <b>{{ STATE[st.state] ?? st.state }}</b>
        <span v-if="st.conflicts.length">충돌 {{ st.conflicts.length }}개를 해결하고 스테이지한 뒤 커밋하세요.</span>
        <span v-else>충돌이 모두 해결되었습니다. 커밋하면 마무리됩니다.</span>
        <div class="spacer" />
        <button class="btn small" @click="abort">취소 (abort)</button>
      </div>

      <div class="body">
        <div class="center-col">
          <GitDiff v-if="git.diff" />
          <GitGraph v-else />
        </div>
        <div class="panel" :style="panelStyle">
          <div class="resizer" @mousedown.prevent="startResize" />
          <GitWip v-if="git.selected === WIP" />
          <GitCommitInfo v-else />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.gitview {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
}
.center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-dim);
}
.toolbar {
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.branch {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  max-width: 260px;
  white-space: nowrap;
  overflow: hidden;
}
.branch b {
  overflow: hidden;
  text-overflow: ellipsis;
}
.ab {
  font-size: 11px;
  font-weight: 700;
  padding: 0 5px;
  border-radius: 8px;
}
.ab.up {
  color: var(--green);
  background: color-mix(in srgb, var(--green) 15%, transparent);
}
.ab.down {
  color: #ff9f0a;
  background: #ff9f0a26;
}
.sep {
  width: 1px;
  height: 22px;
  margin: 0 6px;
  background: var(--border-strong);
}
.tool {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
  min-width: 50px;
  height: 38px;
  padding: 0 6px;
  border-radius: 7px;
  font-size: 10.5px;
  color: var(--text-dim);
}
.ico {
  position: relative;
}
/* count sits on the arrow's lower-right corner, like an app badge */
.badge {
  position: absolute;
  left: 7px;
  top: 5px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  font-size: 9px;
  font-weight: 800;
  line-height: 14px;
  text-align: center;
  color: #fff;
  box-shadow: 0 0 0 1.5px var(--surface-2);
}
.badge.up {
  background: var(--green);
}
.badge.down {
  background: #ff9f0a;
}
.tool:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}
.tool:disabled {
  opacity: 0.4;
}
.ico {
  font-size: 16px;
  line-height: 17px;
}
.spacer {
  flex: 1;
}
.busy {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 45%;
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
}
.prog {
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
}
.spin {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
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
.seg {
  display: flex;
  padding: 2px;
  border-radius: 7px;
  background: var(--hover);
}
.seg button {
  height: 24px;
  padding: 0 10px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--text-dim);
}
.seg button.on {
  background: var(--elevated);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}
.cmp {
  margin-left: 6px;
  height: 26px;
  max-width: 230px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.cmp-sum {
  display: flex;
  gap: 4px;
  margin-left: 6px;
}
.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  background: #ff9f0a22;
  border-bottom: 1px solid #ff9f0a55;
  font-size: 12.5px;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.center-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.panel {
  position: relative;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--surface);
  min-height: 0;
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
</style>
