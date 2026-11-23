<script setup lang="ts">
/**
 * "변경 부분만" diff (Sourcetree style): unified hunks with N context lines,
 * old/new line numbers, syntax colors, and per-hunk stage / unstage / discard.
 */
import { ref, watch, computed } from 'vue'
import { git, diffPrefs, hunkAction } from '../../git'
import { monaco, languageOf } from '../../monaco'
import { store } from '../../store'

interface Line {
  kind: ' ' | '+' | '-' | '\\'
  old: number | null
  new: number | null
  html: string
}
interface Hunk {
  header: string
  range: string
  lines: Line[]
}

const MAX_LINES = 6000
const hunks = ref<Hunk[]>([])
const note = ref<string | null>(null)
const loading = ref(false)
const truncated = ref(false)
let seq = 0

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function parse(text: string): { hunks: Hunk[]; binary: boolean } {
  const out: Hunk[] = []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  let cur: Hunk | null = null
  let o = 0
  let n = 0
  let binary = false
  let total = 0
  truncated.value = false
  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
      o = Number(m?.[1] ?? 1)
      n = Number(m?.[2] ?? 1)
      cur = { header: raw, range: raw.replace(/^(@@[^@]*@@).*$/, '$1'), lines: [] }
      out.push(cur)
      continue
    }
    if (!cur) {
      if (/^Binary files /.test(raw)) binary = true
      continue
    }
    if (++total > MAX_LINES) {
      truncated.value = true
      break
    }
    const kind = (raw[0] ?? ' ') as Line['kind']
    const body = raw.slice(1).replace(/\r$/, '')
    if (kind === '+') cur.lines.push({ kind, old: null, new: n++, html: esc(body) })
    else if (kind === '-') cur.lines.push({ kind, old: o++, new: null, html: esc(body) })
    else if (kind === '\\') cur.lines.push({ kind, old: null, new: null, html: '파일 끝에 줄바꿈 없음' })
    else cur.lines.push({ kind: ' ', old: o++, new: n++, html: esc(body) })
  }
  return { hunks: out, binary }
}

/** Monaco tokenizer colors, one hunk at a time (old/new lines mixed is close enough). */
async function colorize(list: Hunk[], path: string): Promise<void> {
  const lang = languageOf(path)
  if (lang === 'plaintext') return
  for (const h of list) {
    const code = h.lines.filter((l) => l.kind !== '\\')
    if (!code.length) continue
    const text = code.map((l) => l.html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join('\n')
    try {
      const html = await monaco.editor.colorize(text, lang, { tabSize: 4 })
      const parts = html.split('<br/>')
      if (parts.length >= code.length) code.forEach((l, i) => (l.html = parts[i]))
    } catch {
      /* keep plain text */
    }
  }
}

async function load(): Promise<void> {
  const d = git.diff
  if (!d || !store.project) return
  const my = ++seq
  loading.value = true
  try {
    const text = await window.api.git.diffText(store.project.path, JSON.parse(JSON.stringify(d.spec)), diffPrefs.context, diffPrefs.ignoreWs)
    if (my !== seq) return
    const r = parse(text)
    await colorize(r.hunks, d.path)
    if (my !== seq) return
    hunks.value = r.hunks
    note.value = r.binary ? '바이너리 파일은 비교할 수 없습니다' : !r.hunks.length ? (diffPrefs.ignoreWs ? '공백 말고는 바뀐 내용이 없습니다' : '바뀐 내용이 없습니다') : null
  } catch {
    if (my === seq) {
      hunks.value = []
      note.value = '비교 내용을 불러오지 못했습니다'
    }
  } finally {
    if (my === seq) loading.value = false
  }
}

watch(() => [git.diff, git.diffVersion, diffPrefs.context, diffPrefs.ignoreWs], load, { immediate: true })

/** which hunk buttons apply to this diff */
const kind = computed(() => git.diff?.spec.kind)
const canHunk = computed(() => !diffPrefs.ignoreWs && kind.value !== 'commit')

const counts = (h: Hunk): string => {
  const a = h.lines.filter((l) => l.kind === '+').length
  const r = h.lines.filter((l) => l.kind === '-').length
  return `+${a} −${r}`
}
const span = (h: Hunk): string => {
  const nums = h.lines.map((l) => l.new ?? l.old).filter((x): x is number => x !== null)
  return nums.length ? `${Math.min(...nums)}-${Math.max(...nums)} 줄` : ''
}
</script>

<template>
  <div class="hunks">
    <div v-if="note" class="note">{{ note }}</div>
    <div v-else-if="!hunks.length && loading" class="note">불러오는 중…</div>
    <div v-for="(h, i) in hunks" :key="i + h.header" class="hunk">
      <div class="hhead">
        <span class="title">{{ i + 1 }} 부분 : {{ span(h) }}</span>
        <span class="cnt">{{ counts(h) }}</span>
        <span class="range">{{ h.range }}</span>
        <div class="spacer" />
        <template v-if="canHunk">
          <button v-if="kind === 'unstaged' || kind === 'untracked'" class="hbtn" @click="hunkAction(i, h.header, 'stage')">코드뭉치 스테이지에 올리기</button>
          <button v-if="kind === 'staged'" class="hbtn" @click="hunkAction(i, h.header, 'unstage')">코드뭉치 스테이지에서 내리기</button>
          <button v-if="kind === 'unstaged'" class="hbtn danger" @click="hunkAction(i, h.header, 'discard')">버리기</button>
        </template>
        <span v-else-if="diffPrefs.ignoreWs && kind !== 'commit'" class="off" title="공백 무시를 끄면 부분 스테이지를 쓸 수 있습니다">공백 무시 중</span>
      </div>
      <div class="scrollx">
      <table class="code">
        <tbody>
          <tr v-for="(l, j) in h.lines" :key="j" :class="'k' + (l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : l.kind === '\\' ? 'eof' : 'ctx')">
            <td class="ln">{{ l.old ?? '' }}</td>
            <td class="ln">{{ l.new ?? '' }}</td>
            <td class="sign">{{ l.kind === '\\' ? '' : l.kind }}</td>
            <!-- eslint-disable-next-line vue/no-v-html : escaped text or Monaco tokenizer output -->
            <td class="txt" v-html="l.html || '&nbsp;'" />
          </tr>
        </tbody>
      </table>
      </div>
    </div>
    <div v-if="truncated" class="note">변경이 너무 많아 앞부분 {{ MAX_LINES }}줄만 표시했습니다. 전체 비교 보기를 쓰세요.</div>
  </div>
</template>

<style scoped>
.hunks {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 20px;
  background: var(--surface);
  user-select: text;
}
.note {
  padding: 30px;
  text-align: center;
  color: var(--text-faint);
}
.hunk {
  margin-bottom: 14px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  overflow: hidden;
}
.hhead {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 8px 0 12px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  user-select: none;
  white-space: nowrap;
}
.title {
  font-weight: 600;
  font-size: 12px;
}
.cnt {
  font-family: var(--font-code);
  font-size: 11px;
  color: var(--text-dim);
}
.range {
  font-family: var(--font-code);
  font-size: 11px;
  color: var(--text-faint);
}
.spacer {
  flex: 1;
}
.hbtn {
  height: 23px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 12px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
}
.hbtn:hover {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.hbtn.danger:hover {
  background: var(--red);
  border-color: var(--red);
}
.off {
  font-size: 11.5px;
  color: var(--text-faint);
}
.scrollx {
  overflow-x: auto;
}
.code {
  min-width: 100%;
  border-collapse: collapse;
  font-family: var(--font-code);
  font-size: 12.5px;
  line-height: 19px;
}
.ln {
  width: 1%;
  min-width: 44px;
  padding: 0 8px;
  text-align: right;
  color: var(--text-faint);
  font-size: 11.5px;
  border-right: 1px solid var(--border);
  user-select: none;
  white-space: nowrap;
}
.sign {
  width: 18px;
  text-align: center;
  color: var(--text-faint);
  user-select: none;
}
.txt {
  white-space: pre;
  padding-right: 16px;
  tab-size: 4;
}
.kadd {
  background: rgba(46, 160, 67, 0.16);
}
.kadd .sign,
.kadd .ln {
  color: #3fb950;
  background: rgba(46, 160, 67, 0.12);
}
.kdel {
  background: rgba(248, 81, 73, 0.15);
}
.kdel .sign,
.kdel .ln {
  color: #f85149;
  background: rgba(248, 81, 73, 0.12);
}
.keof .txt {
  color: var(--text-faint);
  font-style: italic;
  font-family: var(--font-ui);
  font-size: 11.5px;
}
</style>
