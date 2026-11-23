/**
 * Project search: file list (for "Go to file" / Search Everywhere), text search across the
 * project (Find in Path) and replace (Replace in Path).
 *
 * The file list comes from `git ls-files` when the project is a git repository (fast, and it
 * respects .gitignore, so build output is skipped), otherwise from a folder walk that skips
 * the usual build / tool folders.
 */
import { promises as fs } from 'fs'
import { join, relative, sep } from 'path'
import { git, repoRoot } from './git'
import { publish } from '../core/events'

const SKIP_DIRS = new Set(['node_modules', 'target', 'build', 'out', 'dist', '.git', '.idea', '.gradle', '.mixdog', '.svn', '.vscode', 'bin', '.settings'])
const MAX_FILE = 4 * 1024 * 1024
/** never text: skipped without reading (a web project has thousands of images) */
const BINARY_EXT = /\.(png|gif|jpe?g|bmp|ico|webp|tiff?|psd|svgz|woff2?|ttf|eot|otf|zip|jar|war|ear|class|gz|tgz|7z|rar|exe|dll|so|pdf|docx?|xlsx?|pptx?|hwp|mp[34]|avi|mov|wav|swf|fla|keystore|jks|p12|der|bin|dat|db)$/i
const CACHE_MS = 4000
/** a search never runs longer than this; it returns what it found so far */
const TIME_BUDGET = 30_000

const cache = new Map<string, { at: number; files: string[] }>()

/** Resolve to `fallback` if `p` takes longer than `ms` (guards against a stuck git / disk read). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve(fallback)
      }
    )
  })
}

/** All files of the project, relative paths with "/" separators. */
export async function listFiles(project: string, fresh = false): Promise<string[]> {
  const hit = cache.get(project.toLowerCase())
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.files
  let files: string[] | null = null
  const root = await within(repoRoot(project), 10_000, null)
  if (root) {
    // tracked + untracked-but-not-ignored, relative to the project folder; a git that does not
    // answer in time falls back to the folder walk
    const out = await within(git(project, ['ls-files', '-z', '-co', '--exclude-standard', '--', '.']), 15_000, null as string | null)
    files = out === null ? null : out.split('\0').filter(Boolean)
  }
  files ??= await walk(project)
  cache.set(project.toLowerCase(), { at: Date.now(), files })
  return files
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    let items
    try {
      items = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(
      items.map(async (d) => {
        if (d.isDirectory()) {
          if (!SKIP_DIRS.has(d.name)) await visit(join(dir, d.name))
        } else if (d.isFile()) {
          out.push(relative(root, join(dir, d.name)).split(sep).join('/'))
        }
        if (out.length > 200_000) throw new Error('파일이 너무 많습니다')
      })
    )
  }
  await visit(root)
  return out.sort()
}

/* ---------------- Find in Path ---------------- */

export interface FindOptions {
  query: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  /** file mask, e.g. "*.java, *.jsp" or "!*.min.js" (empty = all files) */
  mask: string
  /** stop after this many matches */
  max?: number
  /** independent search streams: a new search only cancels older ones of the same channel
   *  (the Search Everywhere popup and the search window do not cancel each other) */
  channel?: string
}

export interface FileMatches {
  path: string
  rel: string
  matches: { line: number; col: number; len: number; text: string }[]
}

export interface FindResult {
  files: FileMatches[]
  total: number
  truncated: boolean
  scanned: number
  ms: number
  /** stopped at the time budget: results are partial */
  timedOut?: boolean
  /** replaced by a newer search in the same project (not an error) */
  cancelled?: boolean
}

function buildRegex(o: FindOptions): RegExp {
  let src = o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (o.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`
  return new RegExp(src, `gu${o.caseSensitive ? '' : 'i'}`)
}

/** "*.java, *.jsp, !*.min.js" -> predicate on a relative path */
function maskFilter(mask: string): (rel: string) => boolean {
  const parts = mask.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return () => true
  const toRe = (glob: string): RegExp =>
    new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*') + '$', 'i')
  const inc = parts.filter((p) => !p.startsWith('!')).map(toRe)
  const exc = parts.filter((p) => p.startsWith('!')).map((p) => toRe(p.slice(1)))
  return (rel) => {
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const test = (re: RegExp): boolean => re.test(name) || re.test(rel)
    return (!inc.length || inc.some(test)) && !exc.some(test)
  }
}

/** latest search id per project: a newer search there cancels the older one (other windows are unaffected) */
const latest = new Map<string, number>()
let searchSeq = 0

/** Search the project; a newer search cancels an older one still running. */
export async function findInPath(project: string, o: FindOptions): Promise<FindResult> {
  const key = `${project.toLowerCase()}|${o.channel ?? 'main'}`
  const my = ++searchSeq
  latest.set(key, my)
  const current = (): boolean => latest.get(key) === my
  const started = Date.now()
  const max = o.max ?? 3000
  if (!o.query) return { files: [], total: 0, truncated: false, scanned: 0, ms: 0 }
  let re: RegExp
  try {
    re = buildRegex(o)
  } catch (e) {
    throw new Error(`정규식 오류: ${e instanceof Error ? e.message : e}`)
  }
  const accept = maskFilter(o.mask)
  const files = (await listFiles(project)).filter((f) => !BINARY_EXT.test(f) && accept(f))
  const result: FindResult = { files: [], total: 0, truncated: false, scanned: 0, ms: 0 }

  // read a few files at a time; results keep the file list order
  const slots: (FileMatches | null)[] = new Array(files.length).fill(null)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < files.length && result.total < max && current()) {
      const i = next++
      const rel = files[i]
      const full = join(project, rel)
      if (Date.now() - started > TIME_BUDGET) {
        result.timedOut = true
        break
      }
      // a file that cannot be read within 5s (locked, offline drive...) is skipped
      const buf = await within(
        fs.stat(full).then((st) => (st.isFile() && st.size <= MAX_FILE ? fs.readFile(full) : null)),
        5_000,
        null
      )
      if (!buf) continue
      result.scanned++
      if (buf.subarray(0, 8000).includes(0)) continue // binary
      const text = buf.toString('utf-8')
      re.lastIndex = 0
      if (!re.test(text)) continue
      const fm: FileMatches = { path: full, rel, matches: [] }
      const lines = text.split(/\r?\n/)
      for (let ln = 0; ln < lines.length && result.total < max; ln++) {
        const line = lines[ln]
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(line)) && result.total < max) {
          fm.matches.push({ line: ln + 1, col: m.index + 1, len: Math.max(1, m[0].length), text: line.length > 400 ? line.slice(Math.max(0, m.index - 150), m.index + 250) : line })
          result.total++
          if (m[0].length === 0) re.lastIndex++
        }
      }
      if (fm.matches.length) slots[i] = fm
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  // a newer search took over: end quietly (throwing would show an error toast)
  if (!current()) return { ...result, cancelled: true }
  result.files = slots.filter((x): x is FileMatches => !!x)
  result.truncated = result.total >= max
  result.ms = Date.now() - started
  publish('search.find', { query: o.query, regex: o.regex, mask: o.mask, files: result.files.length, matches: result.total })
  return result
}

/* ---------------- Replace in Path ---------------- */

/**
 * Replace every match in the given files (the ones the user saw in the results).
 * Files open with unsaved changes in the editor are skipped by the caller.
 * Line endings and the rest of each file are kept as they are.
 */
export async function replaceInPath(project: string, o: FindOptions, replacement: string, onlyFiles: string[]): Promise<{ files: number; replaced: number }> {
  const re = buildRegex(o)
  let files = 0
  let replaced = 0
  for (const full of onlyFiles) {
    if (!full.toLowerCase().startsWith(project.toLowerCase())) continue
    let text: string
    try {
      const buf = await fs.readFile(full)
      if (buf.subarray(0, 8000).includes(0)) continue
      text = buf.toString('utf-8')
    } catch {
      continue
    }
    let n = 0
    const out = text.replace(re, (...args) => {
      n++
      if (!o.regex) return replacement
      // $1, $2 ... in regex mode, like the editor's replace
      const groups = args.slice(1, -2) as string[]
      return replacement.replace(/\$(\d+)/g, (_s, d) => groups[Number(d) - 1] ?? '')
    })
    if (!n) continue
    await fs.writeFile(full, out, 'utf-8')
    files++
    replaced += n
  }
  cache.delete(project.toLowerCase())
  publish('search.replace', { query: o.query, replacement, files, replaced })
  return { files, replaced }
}
