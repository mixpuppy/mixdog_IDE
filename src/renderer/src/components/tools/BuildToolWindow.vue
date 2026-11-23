<script setup lang="ts">
/**
 * Maven / Gradle tool window (IntelliJ style): lifecycle, plugins + goals, profiles,
 * dependencies, modules (Maven) or tasks by group (Gradle). Double-click runs, toolbar has
 * 의존성 업데이트 (reload), 목표 실행, offline / skip tests toggles.
 */
import { computed } from 'vue'
import Icon from '../Icon.vue'
import ToolBar from './ToolBar.vue'
import { bt, LIFECYCLE, runGoals, updateDeps, loadGradleTasks, reloadModel, remember, commandFor } from '../../buildtool'
import { ide } from '../../ide'
import { store } from '../../store'
import { run } from '../../commands'
import { promptText, openMenu } from '../../ui'

interface Row {
  key: string
  depth: number
  label: string
  /** dim text after the label */
  hint?: string
  icon: string
  /** expandable group */
  group?: boolean
  /** double-click runs this */
  goals?: string
  module?: string
  /** profile checkbox */
  profile?: string
  dep?: boolean
}

const open = (k: string): boolean => !bt.collapsed[k]
const toggle = (k: string): void => {
  bt.collapsed[k] = !bt.collapsed[k]
}

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  if (bt.tool === 'maven' && bt.pom) {
    const p = bt.pom
    out.push({ key: 'root', depth: 0, label: p.name || p.artifactId, hint: `${p.groupId}:${p.artifactId}:${p.version} · ${p.packaging}`, icon: 'maven', group: true })
    if (!open('root')) return out
    out.push({ key: 'life', depth: 1, label: '라이프사이클', icon: 'refresh', group: true })
    if (open('life')) for (const g of LIFECYCLE) out.push({ key: 'life:' + g, depth: 2, label: g, icon: 'play', goals: g })
    out.push({ key: 'plugins', depth: 1, label: '플러그인', hint: String(p.plugins.length), icon: 'settings', group: true })
    if (open('plugins')) {
      for (const pl of p.plugins) {
        const k = 'pl:' + pl.prefix
        out.push({ key: k, depth: 2, label: pl.prefix, hint: `${pl.artifactId}${pl.version ? ' ' + pl.version : ''}`, icon: 'settings', group: !!pl.goals.length })
        // plugins start collapsed (there are many); expanded = collapsed[k] === false
        if (pl.goals.length && bt.collapsed[k] === false) for (const g of pl.goals) out.push({ key: `${k}:${g}`, depth: 3, label: `${pl.prefix}:${g}`, icon: 'play', goals: `${pl.prefix}:${g}` })
      }
    }
    if (p.profiles.length) {
      out.push({ key: 'profiles', depth: 1, label: '프로필', hint: bt.profiles.length ? bt.profiles.join(', ') : '', icon: 'branch', group: true })
      if (open('profiles')) for (const pr of p.profiles) out.push({ key: 'pr:' + pr.id, depth: 2, label: pr.id, hint: pr.activeByDefault ? '기본 활성' : '', icon: '', profile: pr.id })
    }
    out.push({ key: 'deps', depth: 1, label: '의존성', hint: String(p.dependencies.length), icon: 'open', group: true })
    if (open('deps')) {
      for (const d of p.dependencies) {
        out.push({ key: `dep:${d.groupId}:${d.artifactId}`, depth: 2, label: `${d.groupId}:${d.artifactId}`, hint: `${d.version || '(관리됨)'}${d.scope !== 'compile' ? ' · ' + d.scope : ''}${d.optional ? ' · optional' : ''}`, icon: 'file', dep: true })
      }
    }
    if (p.modules.length) {
      out.push({ key: 'modules', depth: 1, label: '모듈', hint: String(p.modules.length), icon: 'folder', group: true })
      if (open('modules')) {
        for (const m of p.modules) {
          const k = 'mod:' + m
          out.push({ key: k, depth: 2, label: m, icon: 'folder', group: true })
          if (bt.collapsed[k] === false) for (const g of LIFECYCLE) out.push({ key: `${k}:${g}`, depth: 3, label: g, icon: 'play', goals: g, module: m })
        }
      }
    }
  } else if (bt.tool === 'gradle') {
    out.push({ key: 'root', depth: 0, label: store.project?.name ?? 'Gradle', hint: 'Gradle', icon: 'maven', group: true })
    if (!open('root')) return out
    for (const g of bt.gradle) {
      const k = 'g:' + g.name
      out.push({ key: k, depth: 1, label: g.name, hint: String(g.tasks.length), icon: 'folder', group: true })
      if (open(k)) for (const t of g.tasks) out.push({ key: `${k}:${t.name}`, depth: 2, label: t.name, hint: t.desc, icon: 'play', goals: t.name })
    }
  }
  return out
})

/* plugin groups and modules start collapsed (there are many); other groups start open */
const startsCollapsed = (k: string): boolean => k.startsWith('pl:') || k.startsWith('mod:')
function isOpenNode(r: Row): boolean {
  return startsCollapsed(r.key) ? bt.collapsed[r.key] === false : open(r.key)
}
function clickGroup(r: Row): void {
  if (startsCollapsed(r.key)) bt.collapsed[r.key] = bt.collapsed[r.key] === false
  else toggle(r.key)
}

function exec(r: Row): void {
  if (r.goals) runGoals(r.goals, r.module)
  else if (r.group) clickGroup(r)
}

function toggleProfile(id: string): void {
  bt.profiles = bt.profiles.includes(id) ? bt.profiles.filter((x) => x !== id) : [...bt.profiles, id]
}

async function executeGoal(): Promise<void> {
  const r = await promptText(bt.tool === 'gradle' ? 'Gradle 작업 실행' : 'Maven 목표 실행', {
    message: `예: ${bt.tool === 'gradle' ? 'clean bootJar, test --tests *UserTest' : 'clean install, dependency:tree, -pl web package'}\n오프라인·테스트 건너뛰기·프로필 설정이 함께 붙습니다.${bt.history.length ? '\n최근: ' + bt.history.slice(0, 5).join(' | ') : ''}`,
    value: bt.history[0] ?? '',
    ok: '실행'
  })
  if (!r?.value) return
  remember(r.value)
  runGoals(r.value)
}

function rowMenu(e: MouseEvent, r: Row): void {
  if (r.goals) {
    openMenu(e, [
      { label: `실행: ${commandFor(r.goals, r.module)}`, action: () => runGoals(r.goals!, r.module) },
      { label: '테스트 건너뛰고 실행', action: () => runGoals(`${r.goals} ${bt.tool === 'gradle' ? '-x test' : '-DskipTests'}`, r.module) },
      { label: '목표 실행 창에 넣기…', action: () => { remember(r.goals!); executeGoal() }, sep: true }
    ])
  } else if (r.dep && bt.tool === 'maven') {
    openMenu(e, [
      { label: '의존성 트리 보기 (dependency:tree)', action: () => runGoals(`dependency:tree -Dincludes=${r.label}`) },
      { label: '좌표 복사', action: () => navigator.clipboard.writeText(`${r.label}:${r.hint?.split(' ')[0] ?? ''}`) }
    ])
  }
}
</script>

<template>
  <div class="bt">
    <ToolBar>
      <button class="icon-btn" :disabled="!bt.tool || ide.building" :title="bt.tool === 'gradle' ? '의존성 업데이트 (--refresh-dependencies)' : '의존성 업데이트 (-U, 원격 저장소에서 새 버전·스냅샷 확인)'" @click="updateDeps">
        <Icon name="refresh" :size="14" />
      </button>
      <button class="icon-btn" :disabled="!bt.tool || ide.building" :title="bt.tool === 'gradle' ? 'Gradle 작업 실행…' : 'Maven 목표 실행…'" @click="executeGoal">
        <Icon name="terminal" :size="14" />
      </button>
      <button v-if="ide.building" class="icon-btn" title="빌드 중지" @click="run('build.stop')"><Icon name="stop" :size="11" /></button>
      <span class="sep" />
      <button class="tg" :class="{ on: bt.offline }" title="오프라인 모드 (원격 저장소에 접속하지 않음)" @click="bt.offline = !bt.offline">오프라인</button>
      <button class="tg" :class="{ on: bt.skipTests }" title="테스트 건너뛰기" @click="bt.skipTests = !bt.skipTests">테스트 X</button>
      <button v-if="bt.tool === 'gradle'" class="icon-btn" :disabled="bt.gradleLoading" title="작업 목록 다시 불러오기" @click="loadGradleTasks">
        <Icon name="open" :size="14" />
      </button>
      <button v-else class="icon-btn" title="pom.xml 다시 읽기" @click="reloadModel"><Icon name="open" :size="14" /></button>
    </ToolBar>

    <div v-if="!store.project" class="note">프로젝트를 먼저 여세요</div>
    <div v-else-if="!bt.tool" class="note">pom.xml 이나 build.gradle 이 없는 프로젝트입니다</div>
    <div v-else-if="bt.error" class="note err">{{ bt.error }}</div>
    <div v-else-if="bt.tool === 'gradle' && !bt.gradle.length" class="note">
      <p>Gradle 작업 목록을 아직 불러오지 않았습니다.</p>
      <button class="btn small" :disabled="bt.gradleLoading" @click="loadGradleTasks">{{ bt.gradleLoading ? '불러오는 중… (처음엔 오래 걸릴 수 있음)' : '작업 목록 불러오기' }}</button>
    </div>

    <div v-else class="tree" tabindex="0">
      <div
        v-for="r in rows"
        :key="r.key"
        class="row"
        :class="{ sel: bt.selected === r.key, runnable: !!r.goals }"
        :style="{ paddingLeft: 8 + r.depth * 14 + 'px' }"
        :title="r.goals ? `더블클릭: ${commandFor(r.goals, r.module)}` : r.hint"
        @click="bt.selected = r.key; r.group && clickGroup(r)"
        @dblclick="exec(r)"
        @keydown.enter="exec(r)"
        @contextmenu="bt.selected = r.key; rowMenu($event, r)"
      >
        <span class="chev">
          <Icon v-if="r.group" :name="isOpenNode(r) ? 'chevronDown' : 'chevronRight'" :size="11" />
        </span>
        <input v-if="r.profile" type="checkbox" :checked="bt.profiles.includes(r.profile)" @click.stop="toggleProfile(r.profile)" />
        <Icon v-else-if="r.icon" :name="r.icon" :size="13" class="ico" :class="{ go: !!r.goals }" />
        <span class="label">{{ r.label }}</span>
        <span v-if="r.hint" class="hint">{{ r.hint }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bt {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.sep {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border-strong);
}
.tg {
  height: 22px;
  padding: 0 7px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
  border: 1px solid var(--border-strong);
}
.tg:hover {
  background: var(--hover);
}
.tg.on {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  font-weight: 600;
}
.icon-btn:disabled {
  opacity: 0.35;
}
.note {
  padding: 14px;
  color: var(--text-dim);
  line-height: 1.7;
}
.note.err {
  color: var(--red);
}
.tree {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-bottom: 10px;
  outline: none;
}
.row {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  margin: 0 6px;
  padding-right: 8px;
  border-radius: 6px;
  white-space: nowrap;
}
.row:hover {
  background: var(--hover);
}
.row.sel {
  background: var(--accent-soft);
}
.chev {
  width: 12px;
  flex-shrink: 0;
  display: inline-flex;
  color: var(--text-dim);
}
.ico {
  flex-shrink: 0;
  color: var(--text-dim);
}
.ico.go {
  color: var(--green);
}
.label {
  flex-shrink: 0;
}
.row.runnable .label {
  font-family: var(--font-code);
  font-size: 12px;
}
.hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11.5px;
  color: var(--text-dim);
  opacity: 0.75;
}
input[type='checkbox'] {
  margin: 0 2px 0 0;
}
</style>
