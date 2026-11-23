/**
 * Search state: "Go to" popup (Search Everywhere / file / class / recent files) with
 * IntelliJ-like fuzzy matching, and Find / Replace in Path for the search tool window.
 */
import { reactive, watch } from 'vue'
import { store, openFile } from './store'
import { showTool } from './layout'
import { editorRef } from './monaco'

/* ---------------- fuzzy matching ---------------- */

export interface Fuzzy {
  score: number
  /** matched character positions in the tested string (for highlighting) */
  hits: number[]
}

const isBoundary = (s: string, i: number): boolean => {
  if (i === 0) return true
  const p = s[i - 1]
  const c = s[i]
  return /[\\/._\-\s]/.test(p) || (c >= 'A' && c <= 'Z' && !(p >= 'A' && p <= 'Z'))
}

/**
 * Characters of `q` must appear in order in `s`. Word starts / camelCase humps, runs of
 * consecutive characters and a prefix match score higher ("uSI" -> "UserServiceImpl").
 */
export function fuzzy(q: string, s: string): Fuzzy | null {
  if (!q) return { score: 0, hits: [] }
  const ql = q.toLowerCase()
  const sl = s.toLowerCase()
  // fast path: plain substring
  const at = sl.indexOf(ql)
  if (at >= 0) {
    const hits = Array.from({ length: ql.length }, (_, k) => at + k)
    return { score: 1000 - at * 3 + (at === 0 ? 400 : isBoundary(s, at) ? 200 : 0) - s.length, hits }
  }
  const hits: number[] = []
  let score = 0
  let si = 0
  let run = 0
  for (let qi = 0; qi < ql.length; qi++) {
    const ch = ql[qi]
    // prefer the next word boundary that starts with this char, else the next occurrence
    let found = -1
    for (let k = si; k < sl.length; k++) {
      if (sl[k] === ch && isBoundary(s, k)) {
        found = k
        break
      }
    }
    const plain = sl.indexOf(ch, si)
    if (plain < 0) return null
    if (found < 0 || (run > 0 && plain === si)) found = plain
    run = hits.length && found === hits[hits.length - 1] + 1 ? run + 1 : 0
    score += 10 + run * 15 + (isBoundary(s, found) ? 30 : 0) - Math.min(20, found - si)
    hits.push(found)
    si = found + 1
  }
  return { score: score - s.length * 0.5, hits }
}

/* ---------------- recent files (per project) ---------------- */

const recentKey = (): string => `mixdog.recentFiles:${store.project?.path.toLowerCase() ?? ''}`

export function recentFiles(): string[] {
  try {
    return JSON.parse(localStorage.getItem(recentKey()) ?? '[]')
  } catch {
    return []
  }
}

watch(
  () => store.activePath,
  (p) => {
    if (!p || !store.project) return
    try {
      const list = [p, ...recentFiles().filter((x) => x.toLowerCase() !== p.toLowerCase())].slice(0, 50)
      localStorage.setItem(recentKey(), JSON.stringify(list))
    } catch {
      /* storage unavailable */
    }
  }
)

/* ---------------- Go to popup ---------------- */

export type GotoMode = 'all' | 'files' | 'classes' | 'recent'

export const goto = reactive({
  open: false,
  mode: 'all' as GotoMode,
  query: '',
  files: [] as string[],
  loading: false
})

export async function openGoto(mode: GotoMode, query = ''): Promise<void> {
  if (!store.project && mode !== 'all') return
  goto.mode = mode
  goto.query = query
  goto.open = true
  if (!store.project) return
  goto.loading = true
  try {
    goto.files = await window.api.search.files(store.project.path)
  } catch {
    goto.files = []
  } finally {
    goto.loading = false
  }
}

/** "Foo.java:120" or "Foo.java:120:5" -> name + line/column */
export function splitLine(q: string): { q: string; line?: number; col?: number } {
  const m = q.match(/^(.*?):(\d+)(?::(\d+))?$/)
  return m ? { q: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined } : { q }
}

/** Open a project-relative file, optionally at a line, and select a range. */
export async function openAt(full: string, line?: number, col?: number, len?: number): Promise<void> {
  await openFile(full)
  if (!line) return
  const ed = editorRef.current
  if (!ed) return
  const c = col ?? 1
  ed.revealLineInCenter(line)
  if (len) ed.setSelection({ startLineNumber: line, startColumn: c, endLineNumber: line, endColumn: c + len })
  else ed.setPosition({ lineNumber: line, column: c })
  ed.focus()
}

/* ---------------- Find / Replace in Path ---------------- */

export interface FileMatches {
  path: string
  rel: string
  matches: { line: number; col: number; len: number; text: string }[]
}

function pref<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? def : (JSON.parse(v) as T)
  } catch {
    return def
  }
}

export const find = reactive({
  query: '',
  replace: '',
  showReplace: false,
  regex: pref('mixdog.find.regex', false),
  caseSensitive: pref('mixdog.find.case', false),
  wholeWord: pref('mixdog.find.word', false),
  mask: pref('mixdog.find.mask', ''),
  results: [] as FileMatches[],
  total: 0,
  truncated: false,
  timedOut: false,
  ms: 0,
  running: false,
  error: null as string | null,
  /** collapsed files in the result tree */
  collapsed: {} as Record<string, boolean>,
  /** bumped to focus the search box */
  focusTick: 0,
  /** file + match selected with the keyboard */
  sel: null as { file: number; match: number } | null
})

watch(
  () => [find.regex, find.caseSensitive, find.wholeWord, find.mask],
  () => {
    try {
      localStorage.setItem('mixdog.find.regex', JSON.stringify(find.regex))
      localStorage.setItem('mixdog.find.case', JSON.stringify(find.caseSensitive))
      localStorage.setItem('mixdog.find.word', JSON.stringify(find.wholeWord))
      localStorage.setItem('mixdog.find.mask', JSON.stringify(find.mask))
    } catch {
      /* ignore */
    }
  }
)

const options = (): Record<string, unknown> => ({
  query: find.query,
  regex: find.regex,
  caseSensitive: find.caseSensitive,
  wholeWord: find.wholeWord,
  mask: find.mask
})

let seq = 0
export async function runFind(): Promise<void> {
  if (!store.project) return
  const my = ++seq
  find.error = null
  if (!find.query) {
    find.results = []
    find.total = 0
    return
  }
  find.running = true
  try {
    const r = (await window.api.search.find(store.project.path, options())) as unknown as {
      files: FileMatches[]
      total: number
      truncated: boolean
      ms: number
      cancelled?: boolean
      timedOut?: boolean
    }
    if (my !== seq || r.cancelled) return
    find.results = r.files
    find.total = r.total
    find.truncated = r.truncated
    find.timedOut = !!r.timedOut
    find.ms = r.ms
    find.sel = r.files.length ? { file: 0, match: 0 } : null
  } catch (e) {
    if (my !== seq) return
    const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
    if (msg !== '취소됨') find.error = msg
  } finally {
    if (my === seq) find.running = false
  }
}

/** Ctrl+Shift+F: open the search window, prefilled with the editor selection. */
export function openFind(withReplace = false, query?: string): void {
  if (query !== undefined) {
    // an explicit query (e.g. sent from the Search Everywhere popup) wins over the editor selection
    find.query = query
  } else {
    const ed = editorRef.current
    const sel = ed?.getSelection()
    const model = ed?.getModel()
    const text = sel && model && !sel.isEmpty() ? model.getValueInRange(sel) : ''
    if (text && !text.includes('\n')) find.query = text
  }
  if (withReplace) find.showReplace = true
  showTool('search')
  find.focusTick++
  if (find.query) runFind()
}

export { options as findOptions }
