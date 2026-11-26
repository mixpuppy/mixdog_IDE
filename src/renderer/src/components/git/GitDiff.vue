<script setup lang="ts">
/** Side-by-side (or inline) Monaco diff for git.diff. */
import { ref, watch, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import Icon from '../Icon.vue'
import GitHunks from './GitHunks.vue'
import { git, stage, unstage, discard, diffPrefs } from '../../git'
import { openMenu, type MenuItem } from '../../ui'
import { monaco, currentTheme, languageOf, resetEditorServices } from '../../monaco'
import { store, openFile } from '../../store'

const host = ref<HTMLElement | null>(null)
const editor = shallowRef<monaco.editor.IStandaloneDiffEditor | null>(null)
const message = ref<string | null>(null)
const inline = ref(localStorage.getItem('mixdog.diffInline') === '1')
let models: monaco.editor.ITextModel[] = []
let seq = 0

async function content(rev: string | null, path: string): Promise<{ text: string; binary: boolean }> {
  if (!rev || !store.project) return { text: '', binary: false }
  const r = await window.api.git.fileAt(store.project.path, rev, path)
  return { text: r.text ?? '', binary: r.binary }
}

async function load(): Promise<void> {
  const d = git.diff
  if (!d || !editor.value || diffPrefs.mode !== 'full') return
  const my = ++seq
  const [l, r] = await Promise.all([content(d.left, d.from ?? d.path), content(d.right, d.path)])
  if (my !== seq || !editor.value) return
  message.value = l.binary || r.binary ? '바이너리 파일은 비교할 수 없습니다' : null
  const lang = languageOf(d.path)
  const old = models
  models = [monaco.editor.createModel(l.text, lang), monaco.editor.createModel(r.text, lang)]
  editor.value.setModel({ original: models[0], modified: models[1] })
  old.forEach((m) => m.dispose())
}

onMounted(() => {
  editor.value = monaco.editor.createDiffEditor(host.value!, {
    theme: currentTheme(),
    readOnly: true,
    originalEditable: false,
    automaticLayout: true,
    renderSideBySide: !inline.value,
    fontFamily: "'JetBrains Mono', 'D2Coding', Consolas, monospace",
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderOverviewRuler: true,
    ignoreTrimWhitespace: diffPrefs.ignoreWs,
    renderSideBySideInlineBreakpoint: 560
  })
  // don't leave Monaco's global hover factory on the diff editor's scoped services (see monaco.ts)
  resetEditorServices()
  load()
})
onBeforeUnmount(() => {
  editor.value?.dispose()
  models.forEach((m) => m.dispose())
  resetEditorServices()
})
watch(() => [git.diff, git.diffVersion, diffPrefs.mode], load)
watch(() => diffPrefs.ignoreWs, (v) => editor.value?.updateOptions({ ignoreTrimWhitespace: v }))

const CONTEXTS = [1, 3, 6, 12, 25, 50, 100]
function settingsMenu(e: MouseEvent): void {
  const items: MenuItem[] = [
    { label: '공백 무시', checked: diffPrefs.ignoreWs, action: () => (diffPrefs.ignoreWs = !diffPrefs.ignoreWs) },
    ...(diffPrefs.mode === 'full'
      ? [{ label: '한 줄로 보기', checked: inline.value, action: toggleInline, sep: true }]
      : [
          { label: '앞뒤로 보여줄 줄 수', header: true, sep: true },
          ...CONTEXTS.map((n) => ({ label: `${n}줄`, checked: diffPrefs.context === n, action: () => (diffPrefs.context = n) }))
        ])
  ]
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  openMenu(new MouseEvent('contextmenu', { clientX: r.left, clientY: r.bottom + 4 }), items)
}

function toggleInline(): void {
  inline.value = !inline.value
  try {
    localStorage.setItem('mixdog.diffInline', inline.value ? '1' : '0')
  } catch {
    /* ignore */
  }
  editor.value?.updateOptions({ renderSideBySide: !inline.value })
}

function nav(dir: 1 | -1): void {
  editor.value?.goToDiff(dir > 0 ? 'next' : 'previous')
}

const full = (p: string): string => `${git.status?.root ?? ''}/${p}`.replace(/\//g, '\\')
</script>

<template>
  <div class="diff">
    <div class="bar">
      <button class="icon-btn sm" title="그래프로 돌아가기 (Esc)" @click="git.diff = null"><Icon name="x" :size="14" /></button>
      <span class="path">{{ git.diff?.path }}</span>
      <span v-if="git.diff?.from" class="from">← {{ git.diff.from }}</span>
      <span class="title">{{ git.diff?.title }}</span>
      <div class="spacer" />
      <div class="seg">
        <button :class="{ on: diffPrefs.mode === 'hunks' }" title="바뀐 부분과 앞뒤 몇 줄만 (소스트리 방식)" @click="diffPrefs.mode = 'hunks'">변경 부분만</button>
        <button :class="{ on: diffPrefs.mode === 'full' }" title="파일 전체를 나란히 비교" @click="diffPrefs.mode = 'full'">전체 비교</button>
      </div>
      <template v-if="diffPrefs.mode === 'full'">
        <button class="pill-btn" title="이전 변경" @click="nav(-1)">↑</button>
        <button class="pill-btn" title="다음 변경" @click="nav(1)">↓</button>
      </template>
      <span v-else class="ctx-label">앞뒤 {{ diffPrefs.context }}줄{{ diffPrefs.ignoreWs ? ' · 공백 무시' : '' }}</span>
      <button class="pill-btn gear" title="보기 설정 (공백 무시, 앞뒤 줄 수)" @click="settingsMenu">⚙ ▾</button>
      <template v-if="git.diff && git.selected === 'WIP'">
        <button v-if="!git.diff.staged" class="pill-btn" @click="stage([git.diff.path])">스테이지</button>
        <button v-else class="pill-btn" @click="unstage([git.diff.path])">스테이지 취소</button>
      </template>
      <button v-if="git.diff?.right === 'WORKTREE'" class="pill-btn" @click="openFile(full(git.diff.path))">에디터에서 열기</button>
      <button
        v-if="git.diff && git.selected === 'WIP' && !git.diff.staged"
        class="pill-btn danger"
        @click="discard([{ path: git.diff.path, x: git.diff.left ? ' ' : '?', y: 'M' }])"
      >버리기</button>
    </div>
    <GitHunks v-if="diffPrefs.mode === 'hunks'" />
    <template v-else>
      <div v-if="message" class="msg">{{ message }}</div>
    </template>
    <div v-show="diffPrefs.mode === 'full' && !message" ref="host" class="host" />
  </div>
</template>

<style scoped>
.diff {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.bar {
  height: 34px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  white-space: nowrap;
  overflow: hidden;
}
.icon-btn.sm {
  width: 24px;
  height: 24px;
}
.path {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}
.from,
.title {
  color: var(--text-faint);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.spacer {
  flex: 1;
}
.pill-btn {
  font-size: 12px;
  height: 24px;
}
.pill-btn.danger {
  color: var(--red);
}
.seg {
  display: flex;
  padding: 2px;
  border-radius: 7px;
  background: var(--hover);
  flex-shrink: 0;
}
.seg button {
  height: 22px;
  padding: 0 9px;
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
.ctx-label {
  font-size: 11.5px;
  color: var(--text-faint);
}
.host {
  flex: 1;
  min-height: 0;
}
.msg {
  padding: 30px;
  text-align: center;
  color: var(--text-faint);
}
</style>
