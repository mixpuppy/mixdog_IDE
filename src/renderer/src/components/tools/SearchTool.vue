<script setup lang="ts">
/**
 * Find / Replace in Path (Ctrl+Shift+F): search the whole project with case / whole word /
 * regex / file mask options, results grouped by file, click to jump, replace all.
 */
import { ref, watch, computed, nextTick } from 'vue'
import FileIcon from '../FileIcon.vue'
import { find, runFind, openAt, findOptions, type FileMatches } from '../../search'
import { store, tabsOf } from '../../store'
import { confirmSheet } from '../../ui'

const input = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
watch(
  () => find.focusTick,
  async () => {
    await nextTick()
    input.value?.focus()
    input.value?.select()
  }
)

// search as you type (short pause), and again when an option changes
let t: ReturnType<typeof setTimeout> | undefined
watch(
  () => [find.query, find.regex, find.caseSensitive, find.wholeWord, find.mask],
  () => {
    clearTimeout(t)
    // show "검색 중…" right away, not a stale "결과 없음" while waiting for the pause
    find.running = !!find.query
    t = setTimeout(runFind, 280)
  }
)

const fileName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)
const dirName = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')

/** line text split around the match for highlighting (trimmed of leading spaces) */
function pieces(m: FileMatches['matches'][number]): { pre: string; hit: string; post: string } {
  const lead = m.text.length - m.text.trimStart().length
  const s = m.col - 1
  const start = Math.min(lead, s)
  return { pre: m.text.slice(start, s), hit: m.text.slice(s, s + m.len), post: m.text.slice(s + m.len, s + m.len + 200) }
}

function open(fi: number, mi: number): void {
  find.sel = { file: fi, match: mi }
  const f = find.results[fi]
  const m = f.matches[mi]
  openAt(f.path, m.line, m.col, m.len)
}

function onKey(e: KeyboardEvent): void {
  const r = find.results
  if (!r.length) return
  const s = find.sel ?? { file: 0, match: -1 }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const flat: [number, number][] = []
    r.forEach((f, fi) => !find.collapsed[f.path] && f.matches.forEach((_m, mi) => flat.push([fi, mi])))
    let i = flat.findIndex(([a, b]) => a === s.file && b === s.match)
    i = e.key === 'ArrowDown' ? Math.min(flat.length - 1, i + 1) : Math.max(0, i - 1)
    if (flat[i]) find.sel = { file: flat[i][0], match: flat[i][1] }
    nextTick(() => listEl.value?.querySelector('.m.on')?.scrollIntoView({ block: 'nearest' }))
  } else if (e.key === 'Enter' && find.sel && e.target !== input.value) {
    open(find.sel.file, find.sel.match)
  }
}

const summary = computed(() => {
  if (find.running) return '검색 중…'
  if (find.error) return find.error
  if (!find.query) return ''
  if (!find.total) return '결과 없음'
  return `${find.results.length}개 파일에서 ${find.total}개${find.truncated ? '+ (앞부분만 표시)' : ''}${find.timedOut ? ' (시간이 오래 걸려 일부만 검색)' : ''} · ${find.ms}ms`
})

async function replaceAll(files: FileMatches[] = find.results): Promise<void> {
  if (!store.project || !files.length) return
  // files with unsaved edits in the editor would be overwritten by the reload: leave them out
  const dirty = files.filter((f) => tabsOf(f.path).some((x) => x.dirty))
  const target = files.filter((f) => !dirty.includes(f))
  const n = target.reduce((s, f) => s + f.matches.length, 0)
  if (!target.length) return void confirmSheet('바꾸기', '저장하지 않은 수정이 있는 파일뿐이라 바꿀 수 없습니다. 먼저 저장하세요.', '확인')
  const msg =
    `${target.length}개 파일의 ${n}곳을 '${find.replace}' (으)로 바꿉니다.` +
    (dirty.length ? `\n저장하지 않은 수정이 있는 ${dirty.length}개 파일은 건너뜁니다.` : '') +
    '\n에디터에 열린 파일은 자동으로 다시 불러오고 Ctrl+Z 로 되돌릴 수 있습니다. 열려 있지 않은 파일은 되돌리기가 없으니 Git 으로 확인하세요.'
  if (!(await confirmSheet('모두 바꾸기', msg, '바꾸기', true))) return
  await window.api.search.replace(store.project.path, JSON.parse(JSON.stringify(findOptions())), find.replace, target.map((f) => f.path))
  await runFind()
}
</script>

<template>
  <div class="st" @keydown="onKey">
    <div class="form">
      <div class="row">
        <button class="tgl" :class="{ on: find.showReplace }" :title="find.showReplace ? '바꾸기 숨기기' : '바꾸기 열기'" @click="find.showReplace = !find.showReplace">{{ find.showReplace ? '▾' : '▸' }}</button>
        <div class="box">
          <input ref="input" v-model="find.query" spellcheck="false" placeholder="프로젝트에서 찾기 (Ctrl+Shift+F)" @keydown.enter="runFind" />
          <button class="opt" :class="{ on: find.caseSensitive }" title="대소문자 구분" @click="find.caseSensitive = !find.caseSensitive">Aa</button>
          <button class="opt" :class="{ on: find.wholeWord }" title="단어 단위" @click="find.wholeWord = !find.wholeWord"><u>ab</u></button>
          <button class="opt" :class="{ on: find.regex }" title="정규식" @click="find.regex = !find.regex">.*</button>
        </div>
      </div>
      <div v-if="find.showReplace" class="row">
        <span class="sp" />
        <div class="box">
          <input v-model="find.replace" spellcheck="false" :placeholder="find.regex ? '바꿀 내용 ($1, $2 사용 가능)' : '바꿀 내용'" />
        </div>
        <button class="btn small" :disabled="!find.total || find.running" @click="replaceAll()">모두 바꾸기</button>
      </div>
      <div class="row">
        <span class="sp" />
        <div class="box mask">
          <input v-model="find.mask" spellcheck="false" placeholder="파일 마스크 (예: *.java, *.jsp, !*.min.js)" />
        </div>
      </div>
      <div class="summary" :class="{ err: !!find.error }">{{ summary }}</div>
    </div>

    <div ref="listEl" class="results" tabindex="0">
      <template v-for="(f, fi) in find.results" :key="f.path">
        <div class="file" :title="f.rel" @click="find.collapsed[f.path] = !find.collapsed[f.path]">
          <span class="chev">{{ find.collapsed[f.path] ? '▸' : '▾' }}</span>
          <FileIcon :name="f.rel" />
          <b class="fname">{{ fileName(f.rel) }}</b>
          <span class="dir">{{ dirName(f.rel) }}</span>
          <span class="cnt">{{ f.matches.length }}</span>
          <button v-if="find.showReplace" class="mini" title="이 파일만 바꾸기" @click.stop="replaceAll([f])">바꾸기</button>
        </div>
        <template v-if="!find.collapsed[f.path]">
          <div
            v-for="(m, mi) in f.matches"
            :key="mi"
            class="m"
            :class="{ on: find.sel?.file === fi && find.sel?.match === mi }"
            @click="open(fi, mi)"
          >
            <span class="ln">{{ m.line }}</span>
            <span class="code"><span>{{ pieces(m).pre }}</span><mark>{{ pieces(m).hit }}</mark><span>{{ pieces(m).post }}</span></span>
          </div>
        </template>
      </template>
      <div v-if="!store.project" class="none">프로젝트를 먼저 여세요</div>
    </div>
  </div>
</template>

<style scoped>
.st {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.form {
  padding: 2px 10px 6px 6px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex-shrink: 0;
}
.row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tgl,
.sp {
  width: 18px;
  flex-shrink: 0;
  color: var(--text-dim);
  font-size: 11px;
}
.box {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 4px 0 8px;
  border-radius: 7px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
}
.box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.box input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: none;
  color: var(--text);
  font: 12.5px var(--font-code);
}
.box.mask input {
  font-family: var(--font-ui);
}
.opt {
  height: 20px;
  min-width: 24px;
  padding: 0 4px;
  border-radius: 5px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-faint);
  font-family: var(--font-code);
}
.opt:hover {
  background: var(--hover);
}
.opt.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.summary {
  padding-left: 22px;
  font-size: 11.5px;
  color: var(--text-faint);
  min-height: 15px;
}
.summary.err {
  color: var(--red);
}
.results {
  flex: 1;
  min-height: 0;
  overflow: auto;
  outline: none;
  padding-bottom: 10px;
}
.file {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px 0 6px;
  white-space: nowrap;
  position: sticky;
  top: 0;
  background: var(--chrome-strong);
  z-index: 1;
}
.chev {
  width: 12px;
  font-size: 10px;
  color: var(--text-faint);
}
.fname {
  font-size: 12.5px;
}
.dir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11.5px;
  color: var(--text-faint);
  direction: rtl;
  text-align: left;
}
.cnt {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--hover);
  color: var(--text-dim);
}
.mini {
  font-size: 11px;
  color: var(--accent);
}
.m {
  display: flex;
  gap: 8px;
  height: 22px;
  align-items: center;
  padding: 0 8px 0 26px;
  white-space: nowrap;
  font-family: var(--font-code);
  font-size: 12px;
}
.m:hover {
  background: var(--hover);
}
.m.on {
  background: var(--accent-soft);
}
.ln {
  width: 34px;
  flex-shrink: 0;
  text-align: right;
  color: var(--text-faint);
  font-size: 11px;
}
.code {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-dim);
}
mark {
  background: #ffd60a66;
  color: var(--text);
  border-radius: 2px;
  padding: 0 1px;
}
.none {
  padding: 16px;
  color: var(--text-faint);
}
</style>
