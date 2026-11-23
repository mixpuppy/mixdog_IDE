<script setup lang="ts">
/** Right panel for a selected commit: message, author, parents, changed files. */
import { computed } from 'vue'
import GitFileList from './GitFileList.vue'
import { git, select, openCommitDiff, refsAt, newBranch, checkout, cherryPick, revert } from '../../git'
import { toast } from '../../ide'

const d = computed(() => git.detail)
const refs = computed(() => (d.value ? refsAt(d.value.hash) : []))

function copy(text: string): void {
  navigator.clipboard.writeText(text).then(() => toast('복사됨', 'ok'))
}
</script>

<template>
  <div v-if="!d" class="loading">불러오는 중…</div>
  <div v-else class="info">
    <div class="meta">
      <div class="subject">{{ d.subject }}</div>
      <pre v-if="d.body" class="body">{{ d.body }}</pre>
      <div v-if="refs.length" class="refs">
        <span v-for="r in refs" :key="r.ref" class="ref">{{ r.name }}</span>
      </div>
      <div class="kv">
        <span class="k">작성자</span><span>{{ d.author }} &lt;{{ d.email }}&gt;</span>
        <span class="k">날짜</span><span>{{ new Date(d.time).toLocaleString() }}</span>
        <template v-if="d.committer !== d.author"><span class="k">커미터</span><span>{{ d.committer }}</span></template>
        <span class="k">커밋</span><span class="mono link" title="복사" @click="copy(d.hash)">{{ d.hash.slice(0, 12) }}</span>
        <span class="k">부모</span>
        <span>
          <span v-for="p in d.parents" :key="p" class="mono link parent" @click="select(p)">{{ p.slice(0, 7) }}</span>
          <span v-if="!d.parents.length" class="dim">(최초 커밋)</span>
        </span>
      </div>
      <div class="actions">
        <button class="btn small" @click="newBranch(d.hash)">여기서 브랜치</button>
        <button class="btn small" @click="checkout(d.hash)">체크아웃</button>
        <button class="btn small" @click="cherryPick(d.hash)">체리픽</button>
        <button class="btn small" @click="revert(d.hash)">Revert</button>
      </div>
    </div>
    <div class="sec-head">
      변경된 파일 {{ d.files.length }}
      <span v-if="d.parents.length > 1" class="dim"> · 첫 번째 부모 기준</span>
    </div>
    <div class="scroll">
      <GitFileList :files="d.files" letter="x" :active-path="git.diff?.path" @open="openCommitDiff(d, $event)" @menu="() => {}" />
    </div>
  </div>
</template>

<style scoped>
.loading {
  padding: 20px;
  color: var(--text-faint);
}
.info {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.meta {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  user-select: text;
}
.subject {
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.45;
  word-break: break-word;
}
.body {
  margin: 8px 0 0;
  font: 12.5px/1.55 var(--font-ui);
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow: auto;
}
.refs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}
.ref {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--accent-soft);
  color: var(--accent);
}
.kv {
  display: grid;
  grid-template-columns: 46px 1fr;
  gap: 4px 8px;
  margin-top: 10px;
  font-size: 12px;
  word-break: break-all;
}
.k {
  color: var(--text-faint);
}
.mono {
  font-family: var(--font-code);
  font-size: 11.5px;
}
.link {
  color: var(--accent);
  cursor: pointer;
}
.parent {
  margin-right: 8px;
}
.dim {
  color: var(--text-faint);
  font-weight: 400;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 12px;
}
.sec-head {
  height: 30px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-dim);
}
.scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
