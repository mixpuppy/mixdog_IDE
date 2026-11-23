<script setup lang="ts">
/** Left panel of the Git view: local / remote branches, tags, stashes (GitKraken's left column). */
import { computed, ref } from 'vue'
import Icon from '../Icon.vue'
import { git, select, checkout, merge, newBranch, deleteBranch, stashAction, refresh, push, pull, type RefInfo } from '../../git'
import { store } from '../../store'
import { openMenu } from '../../ui'

const filter = ref('')
const open = ref<Record<string, boolean>>({ local: true, remote: true, tag: false, stash: true })

const match = (s: string): boolean => !filter.value || s.toLowerCase().includes(filter.value.toLowerCase())
const locals = computed(() => git.refs.filter((r) => r.kind === 'local' && match(r.name)))
const tags = computed(() => git.refs.filter((r) => r.kind === 'tag' && match(r.name)))
const remotes = computed(() => {
  const groups: Record<string, RefInfo[]> = {}
  for (const r of git.refs.filter((r) => r.kind === 'remote' && match(r.name))) {
    const remote = r.name.split('/')[0]
    ;(groups[remote] ??= []).push(r)
  }
  return groups
})

function showInGraph(r: { hash: string }): void {
  store.mainView = 'git'
  git.diff = null
  select(r.hash)
}

function branchMenu(e: MouseEvent, r: RefInfo): void {
  const items =
    r.kind === 'local'
      ? [
          { label: '체크아웃', action: () => checkout(r.name), disabled: r.current },
          ...(r.current
            ? [{ label: 'Pull', action: () => pull() }, { label: 'Push', action: () => push() }]
            : [{ label: `'${r.name}' 을(를) 현재 브랜치에 병합`, action: () => merge(r.name) }]),
          { label: '여기서 새 브랜치…', action: () => newBranch(r.name), sep: true },
          { label: '그래프에서 보기', action: () => showInGraph(r) },
          { label: '브랜치 삭제…', action: () => deleteBranch(r.name), danger: true, disabled: r.current, sep: true }
        ]
      : [
          { label: '체크아웃 (로컬 브랜치 만들기)', action: () => checkout(r.name) },
          { label: `'${r.name}' 을(를) 현재 브랜치에 병합`, action: () => merge(r.name) },
          { label: '여기서 새 브랜치…', action: () => newBranch(r.name), sep: true },
          { label: '그래프에서 보기', action: () => showInGraph(r) }
        ]
  openMenu(e, items)
}

function stashMenu(e: MouseEvent, index: number): void {
  openMenu(e, [
    { label: '꺼내기 (pop)', action: () => stashAction('pop', index) },
    { label: '적용 (apply, 스태시는 유지)', action: () => stashAction('apply', index) },
    { label: '삭제 (drop)…', action: () => stashAction('drop', index), danger: true, sep: true }
  ])
}
</script>

<template>
  <div class="gs">
    <div class="head">
      <span class="section-label">브랜치</span>
      <div class="actions">
        <button class="icon-btn sm" title="새 브랜치" @click="newBranch()"><Icon name="plus" :size="14" /></button>
        <button class="icon-btn sm" title="새로고침" @click="refresh()"><Icon name="refresh" :size="14" /></button>
      </div>
    </div>
    <div v-if="!store.project" class="empty">프로젝트를 먼저 여세요</div>
    <div v-else-if="!git.isRepo" class="empty">Git 저장소가 아닙니다</div>
    <template v-else>
      <div class="filter"><input v-model="filter" class="input" placeholder="브랜치 찾기" spellcheck="false" /></div>
      <div class="list">
        <div class="grp" @click="open.local = !open.local">
          <Icon :name="open.local ? 'chevronDown' : 'chevronRight'" :size="12" /> 로컬 <span class="n">{{ locals.length }}</span>
        </div>
        <template v-if="open.local">
          <div
            v-for="r in locals"
            :key="r.ref"
            class="item"
            :class="{ current: r.current }"
            :title="r.upstream ? `${r.name} → ${r.upstream}\n더블클릭: 체크아웃` : `${r.name}\n더블클릭: 체크아웃`"
            @click="showInGraph(r)"
            @dblclick="!r.current && checkout(r.name)"
            @contextmenu="branchMenu($event, r)"
          >
            <span class="mark">{{ r.current ? '✓' : '' }}</span>
            <span class="name">{{ r.name }}</span>
            <span v-if="r.ahead" class="ab up">↑{{ r.ahead }}</span>
            <span v-if="r.behind" class="ab down">↓{{ r.behind }}</span>
          </div>
        </template>

        <template v-for="(list, remote) in remotes" :key="remote">
          <div class="grp" @click="open.remote = !open.remote">
            <Icon :name="open.remote ? 'chevronDown' : 'chevronRight'" :size="12" /> 원격: {{ remote }} <span class="n">{{ list.length }}</span>
          </div>
          <template v-if="open.remote">
            <div
              v-for="r in list"
              :key="r.ref"
              class="item"
              :title="`${r.name}\n더블클릭: 로컬로 체크아웃`"
              @click="showInGraph(r)"
              @dblclick="checkout(r.name)"
              @contextmenu="branchMenu($event, r)"
            >
              <span class="mark" />
              <span class="name">{{ r.name.slice(String(remote).length + 1) }}</span>
            </div>
          </template>
        </template>

        <div class="grp" @click="open.tag = !open.tag">
          <Icon :name="open.tag ? 'chevronDown' : 'chevronRight'" :size="12" /> 태그 <span class="n">{{ tags.length }}</span>
        </div>
        <template v-if="open.tag">
          <div v-for="r in tags" :key="r.ref" class="item" @click="showInGraph(r)">
            <span class="mark" />
            <span class="name">{{ r.name }}</span>
          </div>
        </template>

        <div class="grp" @click="open.stash = !open.stash">
          <Icon :name="open.stash ? 'chevronDown' : 'chevronRight'" :size="12" /> 스태시 <span class="n">{{ git.stashes.length }}</span>
        </div>
        <template v-if="open.stash">
          <div
            v-for="s in git.stashes"
            :key="s.ref"
            class="item"
            :title="`${s.ref}: ${s.message}\n더블클릭: 꺼내기`"
            @dblclick="stashAction('pop', s.index)"
            @contextmenu="stashMenu($event, s.index)"
          >
            <span class="mark">⊟</span>
            <span class="name">{{ s.message }}</span>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.gs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.head {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 14px;
  flex-shrink: 0;
}
.actions {
  display: flex;
  gap: 2px;
}
.icon-btn.sm {
  width: 24px;
  height: 24px;
}
.empty {
  padding: 20px 14px;
  color: var(--text-dim);
}
.filter {
  padding: 0 10px 6px;
}
.filter .input {
  width: 100%;
}
.list {
  flex: 1;
  overflow: auto;
  padding-bottom: 10px;
}
.grp {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-dim);
}
.grp:hover {
  color: var(--text);
}
.n {
  margin-left: 4px;
  font-weight: 500;
  color: var(--text-faint);
}
.item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px 0 14px;
  white-space: nowrap;
}
.item:hover {
  background: var(--hover);
}
.item.current {
  font-weight: 700;
}
.mark {
  width: 14px;
  flex-shrink: 0;
  color: var(--accent);
  text-align: center;
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ab {
  font-size: 10.5px;
  font-weight: 700;
}
.ab.up {
  color: var(--green);
}
.ab.down {
  color: #ff9f0a;
}
</style>
