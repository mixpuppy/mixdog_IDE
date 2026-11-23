<script setup lang="ts">
/** Database tool window (IntelliJ style): connections > schemas > tables / views > columns. */
import { onMounted, computed } from 'vue'
import Icon from '../Icon.vue'
import ToolBar from '../tools/ToolBar.vue'
import { openMenu } from '../../ui'
import {
  db,
  loadConnections,
  nodeOf,
  toggleConn,
  toggleSchema,
  toggleTable,
  openConsole,
  newConnection,
  editConnection,
  removeConnection,
  disconnect,
  refresh,
  selectSql,
  kindLabel,
  connOf,
  ensureConnected,
  type DbConn,
  type DbObject
} from '../../db'

onMounted(loadConnections)

const sel = computed(() => db.selected)
const selConnId = computed(() => sel.value?.split('/')[0] ?? null)

function select(key: string): void {
  db.selected = key
}

function copy(text: string): void {
  void navigator.clipboard.writeText(text)
}

function connMenu(e: MouseEvent, c: DbConn): void {
  select(c.id)
  openMenu(e, [
    { label: '쿼리 콘솔 열기', action: () => openConsole(c.id) },
    { label: c.connected ? '연결 끊기' : '연결', action: () => (c.connected ? disconnect(c.id) : ensureConnected(c.id).then((ok) => ok && toggleConn(c.id, true))) },
    { label: '새로고침', action: () => refresh(c.id), disabled: !c.connected },
    { label: '속성…', sep: true, action: () => editConnection(c.id) },
    { label: '복제', action: () => editConnection(c.id, true) },
    { label: '삭제', danger: true, sep: true, action: () => removeConnection(c.id) }
  ])
}

function tableMenu(e: MouseEvent, c: DbConn, schema: string, t: DbObject): void {
  select(`${c.id}/${schema}/${t.name}`)
  openMenu(e, [
    { label: '데이터 보기', action: () => openConsole(c.id, selectSql(c, schema, t.name), true) },
    { label: 'SELECT 문을 콘솔에 넣기', action: () => openConsole(c.id, selectSql(c, schema, t.name)) },
    { label: '이름 복사', sep: true, action: () => copy(t.name) },
    { label: '설명 복사', disabled: !t.comment, action: () => copy(t.comment) }
  ])
}

function openData(c: DbConn, schema: string, t: DbObject): void {
  void openConsole(c.id, selectSql(c, schema, t.name), true)
}

function kindTag(c: DbConn): string {
  return kindLabel(c.kind)
}

function onKey(e: KeyboardEvent): void {
  const id = selConnId.value
  if (!id) return
  if (e.key === 'F4') editConnection(id)
  else if (e.key === 'Delete' && sel.value === id) void removeConnection(id)
  else if (e.key === 'Enter' && e.ctrlKey) void openConsole(id)
}
</script>

<template>
  <div class="dbt">
    <ToolBar>
      <button class="icon-btn" title="새 연결" @click="newConnection"><Icon name="plus" :size="14" /></button>
      <button class="icon-btn" title="쿼리 콘솔 (Ctrl+Enter)" :disabled="!selConnId" @click="selConnId && openConsole(selConnId)"><Icon name="console" :size="14" /></button>
      <button class="icon-btn" title="새로고침" @click="refresh()"><Icon name="refresh" :size="14" /></button>
      <button
        class="icon-btn"
        title="연결 끊기"
        :disabled="!selConnId || !connOf(selConnId)?.connected"
        @click="selConnId && disconnect(selConnId)"
      >
        <Icon name="unplug" :size="14" />
      </button>
      <button class="icon-btn" title="속성 (F4)" :disabled="!selConnId" @click="selConnId && editConnection(selConnId)"><Icon name="settings" :size="14" /></button>
    </ToolBar>

    <div class="tree" tabindex="0" @keydown="onKey">
      <div v-if="db.loaded && !db.conns.length" class="note">
        연결된 DB 가 없습니다.<br />
        <a class="link" @click="newConnection">+ 새 연결</a> 로 Oracle · MariaDB/MySQL · SQL Server · PostgreSQL 을 추가하세요.
      </div>

      <template v-for="c in db.conns" :key="c.id">
        <div
          class="row"
          :class="{ sel: sel === c.id }"
          :style="{ paddingLeft: '6px' }"
          :title="`${kindTag(c)} · ${c.user}@${c.host}:${c.port}${c.database ? '/' + c.database : ''}`"
          @click="select(c.id)"
          @dblclick="toggleConn(c.id)"
          @contextmenu="connMenu($event, c)"
        >
          <span class="chev" @click.stop="toggleConn(c.id)"><Icon :name="nodeOf(c.id)?.open ? 'chevronDown' : 'chevronRight'" :size="12" /></span>
          <Icon name="database" :size="14" class="ico" :class="{ on: c.connected }" />
          <span class="label">{{ c.name }}</span>
          <span v-if="c.readOnly" class="badge">읽기 전용</span>
          <span class="hint">{{ kindTag(c) }}</span>
          <span v-if="nodeOf(c.id)?.loading" class="spin" />
        </div>
        <div v-if="nodeOf(c.id)?.error" class="err" :style="{ paddingLeft: '30px' }">{{ nodeOf(c.id)?.error }}</div>

        <template v-if="nodeOf(c.id)?.open">
          <template v-for="s in nodeOf(c.id)?.schemas ?? []" :key="s">
            <div
              class="row"
              :class="{ sel: sel === `${c.id}/${s}` }"
              :style="{ paddingLeft: '20px' }"
              @click="select(`${c.id}/${s}`)"
              @dblclick="toggleSchema(c.id, s)"
            >
              <span class="chev" @click.stop="toggleSchema(c.id, s)"><Icon :name="nodeOf(`${c.id}/${s}`)?.open ? 'chevronDown' : 'chevronRight'" :size="12" /></span>
              <Icon name="schema" :size="14" class="ico" />
              <span class="label" :class="{ cur: s === nodeOf(c.id)?.current }">{{ s }}</span>
              <span v-if="nodeOf(`${c.id}/${s}`)?.objects" class="hint">{{ nodeOf(`${c.id}/${s}`)?.objects?.length }}</span>
              <span v-if="nodeOf(`${c.id}/${s}`)?.loading" class="spin" />
            </div>
            <div v-if="nodeOf(`${c.id}/${s}`)?.error" class="err" :style="{ paddingLeft: '44px' }">{{ nodeOf(`${c.id}/${s}`)?.error }}</div>

            <template v-if="nodeOf(`${c.id}/${s}`)?.open">
              <template v-for="t in nodeOf(`${c.id}/${s}`)?.objects ?? []" :key="t.name">
                <div
                  class="row"
                  :class="{ sel: sel === `${c.id}/${s}/${t.name}` }"
                  :style="{ paddingLeft: '34px' }"
                  :title="t.comment || t.name"
                  @click="select(`${c.id}/${s}/${t.name}`)"
                  @dblclick="openData(c, s, t)"
                  @contextmenu="tableMenu($event, c, s, t)"
                >
                  <span class="chev" @click.stop="toggleTable(c.id, s, t.name)"><Icon :name="nodeOf(`${c.id}/${s}/${t.name}`)?.open ? 'chevronDown' : 'chevronRight'" :size="12" /></span>
                  <Icon :name="t.type === 'view' ? 'view' : 'table'" :size="14" class="ico" :class="t.type" />
                  <span class="label">{{ t.name }}</span>
                  <span v-if="t.comment" class="hint">{{ t.comment }}</span>
                  <span v-if="nodeOf(`${c.id}/${s}/${t.name}`)?.loading" class="spin" />
                </div>
                <template v-if="nodeOf(`${c.id}/${s}/${t.name}`)?.open">
                  <div
                    v-for="col in nodeOf(`${c.id}/${s}/${t.name}`)?.columns ?? []"
                    :key="col.name"
                    class="row col"
                    :style="{ paddingLeft: '62px' }"
                    :title="col.comment || col.name"
                    @dblclick="copy(col.name)"
                  >
                    <Icon :name="col.pk ? 'key' : 'column'" :size="13" class="ico" :class="{ pk: col.pk }" />
                    <span class="label">{{ col.name }}</span>
                    <span class="type">{{ col.type.toLowerCase() }}{{ col.nullable ? '' : ' not null' }}</span>
                    <span v-if="col.comment" class="hint">{{ col.comment }}</span>
                  </div>
                </template>
              </template>
              <div v-if="nodeOf(`${c.id}/${s}`)?.objects?.length === 0" class="note small" :style="{ paddingLeft: '48px' }">테이블 없음</div>
            </template>
          </template>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.dbt {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.icon-btn:disabled {
  opacity: 0.35;
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
  cursor: default;
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
.ico.on {
  color: var(--green);
}
.ico.table {
  color: var(--accent);
}
.ico.pk {
  color: #d9a400;
}
.label {
  flex-shrink: 0;
}
.label.cur {
  font-weight: 600;
}
.row.col .label {
  font-family: var(--font-code);
  font-size: 12px;
}
.type {
  flex-shrink: 0;
  font-family: var(--font-code);
  font-size: 11px;
  color: var(--text-dim);
  opacity: 0.85;
}
.hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11.5px;
  color: var(--text-dim);
}
.badge {
  flex-shrink: 0;
  font-size: 10.5px;
  padding: 0 5px;
  border-radius: 4px;
  color: var(--accent);
  background: var(--accent-soft);
}
.spin {
  width: 10px;
  height: 10px;
  flex-shrink: 0;
  border: 1.5px solid var(--text-faint);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.err {
  margin: 2px 12px 4px;
  font-size: 11.5px;
  color: var(--red);
  white-space: pre-wrap;
  user-select: text;
}
.note {
  padding: 14px;
  color: var(--text-dim);
  line-height: 1.7;
}
.note.small {
  padding: 2px 0;
  font-size: 11.5px;
}
.link {
  color: var(--accent);
  cursor: pointer;
}
</style>
