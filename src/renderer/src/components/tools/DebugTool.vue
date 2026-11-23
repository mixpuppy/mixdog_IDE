<script setup lang="ts">
/**
 * Debug window (IntelliJ style): run controls, call stack (per thread) and variables.
 * F9 resume · F8 step over · F7 step into · Shift+F8 step out.
 */
import Icon from '../Icon.vue'
import ToolBar from './ToolBar.vue'
import VarTree from './VarTree.vue'
import { dbg, resume, stepOver, stepInto, stepOut, detach, attach, selectFrame, selectThread, toggleMute, removeBreakpoint, removeAll, setEnabled, editCondition } from '../../debug'
import { openAt } from '../../search'
import { store } from '../../store'
import { run } from '../../commands'

const fileOf = (p: string | null): string => (p ? p.split(/[\\/]/).pop() ?? p : '')
const short = (cls: string): string => cls.split('.').pop() ?? cls
const rel = (p: string): string => {
  const root = store.project?.path ?? ''
  return root && p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length + 1) : p
}
</script>

<template>
  <div class="tool">
    <ToolBar>
      <button class="icon-btn go" :disabled="!dbg.paused" title="계속 (F9)" @click="resume"><Icon name="resume" :size="14" /></button>
      <button class="icon-btn" :disabled="!dbg.paused" title="다음 줄 (F8)" @click="stepOver"><Icon name="stepOver" :size="14" /></button>
      <button class="icon-btn" :disabled="!dbg.paused" title="들어가기 (F7)" @click="stepInto"><Icon name="stepInto" :size="14" /></button>
      <button class="icon-btn" :disabled="!dbg.paused" title="나오기 (Shift+F8)" @click="stepOut"><Icon name="stepOut" :size="14" /></button>
      <span class="sep" />
      <button class="icon-btn" :class="{ on: dbg.view === 'breakpoints' }" title="중단점 목록" @click="dbg.view = dbg.view === 'breakpoints' ? 'frames' : 'breakpoints'">
        <span class="dot" />
      </button>
      <button class="icon-btn" :class="{ on: dbg.muted }" title="중단점 모두 끄기 / 켜기" @click="toggleMute"><Icon name="mute" :size="14" /></button>
      <span class="sep" />
      <button v-if="dbg.attached" class="icon-btn" title="디버거 연결 끊기 (Tomcat 은 계속 실행)" @click="detach"><Icon name="unplug" :size="14" /></button>
      <button v-else class="icon-btn" title="실행 중인 JVM 의 디버그 포트에 연결" @click="attach"><Icon name="plug" :size="14" /></button>
      <span class="state">
        <template v-if="dbg.paused">● 멈춤 · {{ dbg.reason === 'breakpoint' ? '중단점' : '단계 실행' }}</template>
        <template v-else-if="dbg.attached">실행 중 (디버거 연결됨)</template>
        <template v-else>연결 안 됨</template>
      </span>
    </ToolBar>

    <div v-if="!dbg.attached && !dbg.frames.length && dbg.view === 'frames'" class="empty">
      <b>Shift+F9</b> (디버그 실행) 로 Tomcat 을 띄우면 디버거가 자동으로 연결됩니다.<br />
      <span class="dim">.java 파일의 줄 번호 왼쪽을 클릭하면 중단점(빨간 점) · 우클릭하면 조건 · Ctrl+F8 은 커서 줄에 중단점</span>
      <div class="actions"><button class="btn" @click="run('run.debug')">디버그 실행 (Shift+F9)</button></div>
    </div>

    <div v-else class="split">
      <!-- left: frames / breakpoints -->
      <div class="left">
        <template v-if="dbg.view === 'frames'">
          <select v-if="dbg.threads.length" class="thread" :value="dbg.thread" @change="selectThread(($event.target as HTMLSelectElement).value)">
            <option v-for="t in dbg.threads" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
          <div class="list">
            <div v-if="!dbg.paused" class="note">멈추면 호출 스택이 여기 나옵니다.</div>
            <div
              v-for="(f, i) in dbg.paused ? dbg.frames : []"
              :key="f.handle"
              class="frame"
              :class="{ on: i === dbg.frame, lib: !f.path }"
              :title="`${f.cls}.${f.method}():${f.line}`"
              @click="selectFrame(i)"
            >
              <span class="m">{{ f.method }}</span>
              <span class="loc">{{ f.path ? `${fileOf(f.path)}:${f.line}` : `${short(f.cls)}:${f.line}` }}</span>
              <span class="pkg">{{ f.cls }}</span>
            </div>
          </div>
        </template>
        <div v-else class="list">
          <div v-if="!dbg.breakpoints.length" class="note">중단점이 없습니다.</div>
          <div v-for="b in dbg.breakpoints" :key="b.path + b.line" class="bprow" :title="b.path">
            <input type="checkbox" :checked="b.enabled" @change="setEnabled(b, ($event.target as HTMLInputElement).checked)" />
            <span class="bpname" @click="openAt(b.path, b.line)">{{ fileOf(b.path) }}:{{ b.line }}</span>
            <span class="pkg">{{ b.condition ? `조건: ${b.condition}` : rel(b.path) }}</span>
            <span class="grow" />
            <button class="mini" title="조건" @click="editCondition(b.path, b.line)"><Icon name="edit" :size="11" /></button>
            <button class="mini" title="삭제" @click="removeBreakpoint(b)"><Icon name="x" :size="11" /></button>
          </div>
          <button v-if="dbg.breakpoints.length" class="link" @click="removeAll">모두 지우기</button>
        </div>
      </div>
      <!-- right: variables -->
      <div class="right">
        <div v-if="dbg.loadingVars && !dbg.vars.length" class="note">변수 읽는 중…</div>
        <div v-else-if="!dbg.paused" class="note">멈추면 변수가 여기 나옵니다.</div>
        <div v-if="dbg.varsNote" class="note">{{ dbg.varsNote }}</div>
        <VarTree v-if="dbg.paused" :nodes="dbg.vars" :depth="0" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.icon-btn:disabled {
  opacity: 0.3;
}
.icon-btn.go:not(:disabled) {
  color: var(--green);
}
.icon-btn.on {
  color: var(--accent);
  background: var(--accent-soft);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #e5484d;
}
.sep {
  width: 1px;
  height: 14px;
  margin: 0 4px;
  background: var(--border-strong);
}
.state {
  margin-left: 8px;
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
}
.empty {
  padding: 14px;
  line-height: 1.8;
}
.dim {
  color: var(--text-dim);
  font-size: 12px;
}
.actions {
  margin-top: 8px;
}
.split {
  flex: 1;
  min-height: 0;
  display: flex;
}
.left {
  width: 38%;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
}
.right {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 4px 0 10px;
}
.thread {
  margin: 6px 8px 2px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 2px 0 8px;
}
.note {
  padding: 10px 12px;
  color: var(--text-dim);
  font-size: 12px;
}
.frame,
.bprow {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  margin: 0 6px;
  padding: 0 8px;
  border-radius: 6px;
  white-space: nowrap;
  cursor: pointer;
  font-size: 12.5px;
}
.frame:hover,
.bprow:hover {
  background: var(--hover);
}
.frame.on {
  background: var(--accent-soft);
}
.frame.lib {
  color: var(--text-dim);
}
.m {
  font-family: var(--font-code);
  font-size: 12px;
}
.loc {
  color: var(--accent);
  font-size: 12px;
}
.frame.lib .loc {
  color: var(--text-dim);
}
.pkg {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-faint);
  font-size: 11px;
}
.bpname {
  font-family: var(--font-code);
  font-size: 12px;
}
.grow {
  flex: 1;
}
.mini {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--text-dim);
}
.mini:hover {
  background: var(--hover);
}
.link {
  margin: 6px 14px;
  color: var(--accent);
  font-size: 12px;
}
</style>
