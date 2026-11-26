<script setup lang="ts">
/** Right panel for the "작업 중" row: unstaged / staged files and the commit box. */
import { computed, ref } from 'vue'
import GitFileList from './GitFileList.vue'
import { git, stage, unstage, discard, commit, startAmend, openWipDiff, type FileChange } from '../../git'
import { openMenu } from '../../ui'
import { openFile } from '../../store'
import { run } from '../../commands'
import { openResolver } from '../../conflicts'

const st = computed(() => git.status)
const unstaged = computed(() => st.value?.unstaged ?? [])
const staged = computed(() => st.value?.staged ?? [])
const conflicts = computed(() => st.value?.conflicts ?? [])
const activePath = computed(() => git.diff?.path ?? null)

const full = (p: string): string => `${st.value!.root}/${p}`.replace(/\//g, '\\')

function menuUnstaged(e: MouseEvent, f: FileChange): void {
  openMenu(e, [
    { label: '스테이지', action: () => stage([f.path]) },
    { label: '에디터에서 열기', action: () => f.y !== 'D' && openFile(full(f.path)), disabled: f.y === 'D' },
    { label: '변경 사항 버리기…', action: () => discard([f]), danger: true, sep: true }
  ])
}
function menuStaged(e: MouseEvent, f: FileChange): void {
  openMenu(e, [
    { label: '스테이지 취소', action: () => unstage([f.path]) },
    { label: '에디터에서 열기', action: () => f.x !== 'D' && openFile(full(f.path)), disabled: f.x === 'D' }
  ])
}

function onKey(e: KeyboardEvent): void {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault()
    commit()
  }
}

/* ---- draggable dividers: changes | staged | commit box (remembered) ---- */
const root = ref<HTMLElement | null>(null)
const num = (k: string, d: number): number => {
  try {
    const v = Number(localStorage.getItem(k))
    return Number.isFinite(v) && v > 0 ? v : d
  } catch {
    return d
  }
}
/** share of the free height given to "변경 사항" (the rest goes to "스테이지됨") */
const ratio = ref(num('mixdog.wipRatio', 0.5))
const commitH = ref(num('mixdog.wipCommitH', 190))
function drag(e: MouseEvent, which: 'lists' | 'commit'): void {
  const box = root.value?.getBoundingClientRect()
  if (!box) return
  const lists = root.value!.querySelectorAll<HTMLElement>('.section.grow')
  const top = lists[0]?.getBoundingClientRect().top ?? box.top
  const startY = e.clientY
  const startH = commitH.value
  const move = (ev: MouseEvent): void => {
    if (which === 'commit') {
      commitH.value = Math.min(box.height - 140, Math.max(120, startH - (ev.clientY - startY)))
    } else {
      const free = box.bottom - commitH.value - top
      ratio.value = Math.min(0.9, Math.max(0.1, (ev.clientY - top) / free))
    }
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
    try {
      localStorage.setItem('mixdog.wipRatio', String(ratio.value))
      localStorage.setItem('mixdog.wipCommitH', String(commitH.value))
    } catch {
      /* ignore */
    }
  }
  document.body.style.cursor = 'row-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

const canCommit = computed(() => !!git.commitMsg.trim() && (git.amend || staged.value.length > 0) && !conflicts.value.length)
</script>

<template>
  <div ref="root" class="wip">
    <div v-if="conflicts.length" class="section">
      <div class="sec-head conflict">
        <span>충돌 {{ conflicts.length }}</span>
        <span class="hint">파일을 누르면 충돌 해결 화면</span>
        <button class="link" @click="openResolver(conflicts.map((f) => f.path))">모두 해결…</button>
      </div>
      <GitFileList
        :files="conflicts"
        letter="y"
        action-label="해결됨"
        :active-path="activePath"
        @open="openResolver(conflicts.map((f) => f.path), $event.path)"
        @action="stage([$event.path])"
        @menu="(e, f) => openMenu(e, [{ label: '충돌 해결 화면…', action: () => openResolver(conflicts.map((x) => x.path), f.path) }, { label: '에디터에서 열기', action: () => openFile(full(f.path)) }, { label: '해결됨으로 스테이지', action: () => stage([f.path]) }])"
      />
    </div>

    <div class="section grow" :style="{ flex: `${ratio} 1 0` }">
      <div class="sec-head">
        <span>변경 사항 {{ unstaged.length }}</span>
        <div class="sec-btns">
          <button v-if="unstaged.length" class="link danger" @click="discard(unstaged)">모두 버리기</button>
          <button v-if="unstaged.length" class="link" @click="stage(unstaged.map((f) => f.path))">모두 스테이지</button>
        </div>
      </div>
      <div class="scroll">
        <GitFileList
          :files="unstaged"
          letter="y"
          action-label="스테이지"
          :active-path="git.diff && !git.diff.staged ? activePath : null"
          @open="openWipDiff($event, false)"
          @action="stage([$event.path])"
          @menu="menuUnstaged"
        />
        <div v-if="!unstaged.length" class="none">변경된 파일이 없습니다</div>
      </div>
    </div>

    <div class="split" title="드래그해서 크기 조절" @mousedown.prevent="drag($event, 'lists')" />
    <div class="section grow" :style="{ flex: `${1 - ratio} 1 0` }">
      <div class="sec-head">
        <span>스테이지됨 {{ staged.length }}</span>
        <div class="sec-btns">
          <button v-if="staged.length" class="link" @click="unstage(staged.map((f) => f.path))">모두 취소</button>
        </div>
      </div>
      <div class="scroll">
        <GitFileList
          :files="staged"
          letter="x"
          action-label="취소"
          :active-path="git.diff?.staged ? activePath : null"
          @open="openWipDiff($event, true)"
          @action="unstage([$event.path])"
          @menu="menuStaged"
        />
        <div v-if="!staged.length" class="none">스테이지된 파일이 없습니다</div>
      </div>
    </div>

    <div class="split" title="드래그해서 크기 조절" @mousedown.prevent="drag($event, 'commit')" />
    <div class="commit-box" :style="{ height: commitH + 'px' }">
      <textarea
        v-model="git.commitMsg"
        class="msg"
        :placeholder="git.amend ? '수정할 커밋 메시지' : '커밋 메시지 (Ctrl+Enter 로 커밋)'"
        spellcheck="false"
        @keydown="onKey"
      />
      <div class="commit-row">
        <label class="amend"><input type="checkbox" :checked="git.amend" @change="startAmend(($event.target as HTMLInputElement).checked)" /> 마지막 커밋 수정</label>
        <button class="link" title="Claude 에게 커밋 메시지 작성을 부탁합니다" @click="run('git.askClaudeMessage')">✨ Claude</button>
      </div>
      <button class="primary-btn commit-btn" :disabled="!canCommit || !!git.busy" @click="commit">
        {{ git.amend ? '커밋 수정' : staged.length ? `${staged.length}개 파일 커밋` : '커밋' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.wip {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.section {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-bottom: 1px solid var(--border);
}
.section.grow {
  flex: 1;
  border-bottom: none;
}
.split {
  flex-shrink: 0;
  height: 7px;
  margin: -3px 0;
  position: relative;
  z-index: 2;
  cursor: row-resize;
}
.split::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 3px;
  height: 1px;
  background: var(--border);
}
.split:hover::after {
  height: 3px;
  top: 2px;
  background: var(--accent);
}
.scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-bottom: 4px;
}
.sec-head {
  height: 30px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 0 12px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-dim);
}
.sec-head.conflict {
  color: var(--red);
}
.sec-btns {
  display: flex;
  gap: 10px;
}
.link {
  font-size: 11.5px;
  color: var(--accent);
  font-weight: 500;
}
.link:hover {
  text-decoration: underline;
}
.link.danger {
  color: var(--red);
}
.hint {
  font-weight: 400;
  color: var(--text-faint);
}
.none {
  padding: 8px 14px;
  color: var(--text-faint);
  font-size: 12px;
}
.commit-box {
  flex-shrink: 0;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--surface-2);
}
.msg {
  flex: 1;
  min-height: 40px;
  resize: none;
  padding: 8px;
  border-radius: 7px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  font: 12.5px/1.5 var(--font-ui);
  outline: none;
  user-select: text;
}
.msg:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.commit-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.amend {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dim);
  font-size: 12px;
}
.commit-btn {
  justify-content: center;
}
.commit-btn:disabled {
  opacity: 0.45;
  filter: none;
}
</style>
