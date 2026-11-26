/**
 * Git service: thin wrappers over the git CLI (the user's own install / credentials).
 *
 * Reads (status, log, branches, diff contents) return parsed data. Every write
 * (stage, commit, checkout, pull, push...) is published as a `git.*` event so the
 * AI sees what the user does in the Git view. `.git` changes (HEAD, index, refs)
 * are watched and published as `git.changed` so the view refreshes itself, also
 * when Claude or the terminal runs git.
 */
import { execFile, spawn } from 'child_process'
import { watch, existsSync, statSync, readFileSync, writeFileSync, mkdirSync, type FSWatcher } from 'fs'
import { join, isAbsolute, resolve, dirname } from 'path'
import { shell } from 'electron'
import { publish } from '../core/events'
import { allWindows } from '../core/windows'

const US = '\x1f'
const RS = '\x1e'

/** Always-on options: UTF-8 paths, no pager, no interactive prompts. */
const BASE = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.editor=true']

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', LC_ALL: 'C.UTF-8' }
}

export class GitError extends Error {}

/** Run git and return stdout. `input` goes to stdin. */
export function git(cwd: string, args: string[], opts: { input?: string; maxBuffer?: number; raw?: boolean; okExit?: number[] } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      [...BASE, ...args],
      { cwd, env: gitEnv(), windowsHide: true, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code
        if (err && !(typeof code === 'number' && opts.okExit?.includes(code))) {
          const msg = (stderr?.toString('utf-8') || stdout?.toString('utf-8') || err.message).trim()
          reject(new GitError(msg))
        } else resolvePromise(stdout.toString(opts.raw ? 'latin1' : 'utf-8'))
      }
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input, opts.raw ? 'latin1' : 'utf-8')
  })
}

/** Long-running remote command (pull/push/fetch): progress lines go to the event log. */
function gitRemote(cwd: string, args: string[], op: string, source: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', [...BASE, ...args], { cwd, env: gitEnv(), windowsHide: true })
    let out = ''
    const onData = (b: Buffer): void => {
      const s = b.toString('utf-8')
      out += s
      for (const line of s.split(/[\r\n]+/)) if (line.trim()) publish('git.progress', { op, line: line.trim() }, source)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (e) => reject(new GitError(String(e))))
    child.on('close', (code) => (code === 0 ? resolvePromise(out.trim()) : reject(new GitError(out.trim() || `git ${op} 실패 (${code})`))))
  })
}

/* ---------------- repository discovery ---------------- */

const rootCache = new Map<string, string | null>()

export async function repoRoot(projectPath: string): Promise<string | null> {
  if (rootCache.has(projectPath)) return rootCache.get(projectPath) ?? null
  let root: string | null = null
  try {
    root = resolve((await git(projectPath, ['rev-parse', '--show-toplevel'])).trim())
  } catch {
    root = null
  }
  rootCache.set(projectPath, root)
  return root
}

export async function needRoot(projectPath: string): Promise<string> {
  const r = await repoRoot(projectPath)
  if (!r) throw new GitError('Git 저장소가 아닙니다')
  return r
}

/* ---------------- status ---------------- */

export interface FileChange {
  path: string
  /** original path for renames */
  from?: string
  /** index (staged) status letter: M A D R C U ? or ' ' */
  x: string
  /** worktree status letter */
  y: string
}

export interface GitStatus {
  root: string
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  conflicts: FileChange[]
  /** MERGING / REBASING / CHERRY-PICKING ... */
  state: string | null
}

export async function status(projectPath: string): Promise<GitStatus | null> {
  const root = await repoRoot(projectPath)
  if (!root) return null
  const out = await git(root, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'])
  const parts = out.split('\0')
  const st: GitStatus = {
    root, branch: null, detached: false, upstream: null, ahead: 0, behind: 0,
    staged: [], unstaged: [], conflicts: [], state: repoState(root)
  }
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (!e) continue
    if (e.startsWith('## ')) {
      parseBranchLine(e.slice(3), st)
      continue
    }
    const x = e[0]
    const y = e[1]
    const path = e.slice(3)
    const ch: FileChange = { path, x, y }
    if (x === 'R' || x === 'C') ch.from = parts[++i]
    const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
    if (conflict) st.conflicts.push(ch)
    else if (x === '?') st.unstaged.push({ path, x: '?', y: '?' })
    else {
      if (x !== ' ') st.staged.push(ch)
      if (y !== ' ') st.unstaged.push({ path, x, y })
    }
  }
  return st
}

function parseBranchLine(s: string, st: GitStatus): void {
  // "main...origin/main [ahead 1, behind 2]" | "No commits yet on main" | "HEAD (no branch)"
  const track = s.match(/\[(.*)\]$/)
  if (track) {
    st.ahead = Number(track[1].match(/ahead (\d+)/)?.[1] ?? 0)
    st.behind = Number(track[1].match(/behind (\d+)/)?.[1] ?? 0)
    s = s.slice(0, track.index).trim()
  }
  if (s.startsWith('No commits yet on ')) {
    st.branch = s.slice('No commits yet on '.length)
    return
  }
  if (s.startsWith('HEAD (no branch)')) {
    st.detached = true
    return
  }
  const [branch, upstream] = s.split('...')
  st.branch = branch
  st.upstream = upstream ?? null
}

function gitDir(root: string): string {
  const dot = join(root, '.git')
  try {
    if (statSync(dot).isFile()) {
      // worktree / submodule: "gitdir: <path>"
      const p = readFileSync(dot, 'utf-8').replace(/^gitdir:\s*/, '').trim()
      return isAbsolute(p) ? p : resolve(root, p)
    }
  } catch {
    /* no .git */
  }
  return dot
}

function repoState(root: string): string | null {
  const d = gitDir(root)
  if (existsSync(join(d, 'MERGE_HEAD'))) return 'MERGING'
  if (existsSync(join(d, 'rebase-merge')) || existsSync(join(d, 'rebase-apply'))) return 'REBASING'
  if (existsSync(join(d, 'CHERRY_PICK_HEAD'))) return 'CHERRY-PICKING'
  if (existsSync(join(d, 'REVERT_HEAD'))) return 'REVERTING'
  return null
}

/* ---------------- refs ---------------- */

export interface RefInfo {
  name: string
  /** full ref, e.g. refs/heads/main */
  ref: string
  kind: 'local' | 'remote' | 'tag'
  hash: string
  upstream: string | null
  ahead: number
  behind: number
  current: boolean
}

export interface StashInfo {
  index: number
  ref: string
  hash: string
  message: string
}

export async function refs(projectPath: string): Promise<{ refs: RefInfo[]; stashes: StashInfo[]; remotes: string[] }> {
  const root = await needRoot(projectPath)
  const fmt = ['%(refname)', '%(refname:short)', '%(objectname)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)', '%(*objectname)'].join(US)
  const [out, stashOut, remoteOut] = await Promise.all([
    git(root, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
    git(root, ['stash', 'list', `--format=%gd${US}%H${US}%gs`]).catch(() => ''),
    git(root, ['remote']).catch(() => '')
  ])
  const list: RefInfo[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [ref, name, hash, upstream, track, head, peeled] = line.split(US)
    if (ref.endsWith('/HEAD')) continue // origin/HEAD symbolic ref
    const kind = ref.startsWith('refs/heads/') ? 'local' : ref.startsWith('refs/remotes/') ? 'remote' : 'tag'
    list.push({
      name, ref, kind,
      hash: peeled || hash, // annotated tags point at the tag object; use the commit
      upstream: upstream || null,
      ahead: Number(track.match(/ahead (\d+)/)?.[1] ?? 0),
      behind: Number(track.match(/behind (\d+)/)?.[1] ?? 0),
      current: head === '*'
    })
  }
  const stashes = stashOut
    .split('\n')
    .filter(Boolean)
    .map((l, index) => {
      const [ref, hash, message] = l.split(US)
      return { index, ref, hash, message }
    })
  return { refs: list, stashes, remotes: remoteOut.split('\n').map((s) => s.trim()).filter(Boolean) }
}

/* ---------------- log ---------------- */

export interface Commit {
  hash: string
  parents: string[]
  author: string
  email: string
  time: number
  subject: string
}

export interface LogResult {
  commits: Commit[]
  head: string | null
  /** what "current" mode compares HEAD with (upstream by default) */
  compare: string | null
  /** commits on HEAD that the compare branch lacks (to push) */
  outgoing: string[]
  /** commits on the compare branch that HEAD lacks (to pull) */
  incoming: string[]
  /** exact counts (the hash lists are capped) */
  ahead: number
  behind: number
}

/**
 * scope "all": every branch, remote and tag (Sourcetree "모든 브랜치").
 * scope "current": HEAD plus the branch it is compared with - its upstream unless
 * `compare` names another branch (Sourcetree "현재 브랜치").
 */
export async function log(projectPath: string, limit = 400, scope: 'all' | 'current' = 'all', compareWith: string | null = null): Promise<LogResult> {
  const root = await needRoot(projectPath)
  const head = await git(root, ['rev-parse', 'HEAD']).then((s) => s.trim(), () => null)
  if (!head) return { commits: [], head: null, compare: null, outgoing: [], incoming: [], ahead: 0, behind: 0 }
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).then((s) => s.trim(), () => null)
  let compare = compareWith || upstream
  if (compare && !(await git(root, ['rev-parse', '--verify', '-q', `${compare}^{commit}`]).then(() => true, () => false))) compare = null
  // %B (raw message) instead of %s: git's %s joins the whole first paragraph into one line, so a
  // message with lines right under the title ("title\n-. item") would show as one long subject
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%B'].join(US) + RS
  const revs = scope === 'current' ? ['HEAD', ...(compare ? [compare] : [])] : ['--branches', '--remotes', '--tags', 'HEAD']
  const [out, outgoing, incoming, counts] = await Promise.all([
    git(root, ['log', ...revs, '--topo-order', `-n${limit}`, `--format=${fmt}`, '--']),
    compare ? git(root, ['rev-list', '-n2000', `${compare}..HEAD`, '--']).catch(() => '') : Promise.resolve(''),
    compare ? git(root, ['rev-list', '-n2000', `HEAD..${compare}`, '--']).catch(() => '') : Promise.resolve(''),
    compare ? git(root, ['rev-list', '--left-right', '--count', `HEAD...${compare}`, '--']).catch(() => '0	0') : Promise.resolve('0	0')
  ])
  const [ahead, behind] = counts.trim().split(/\s+/).map(Number)
  const commits = out
    .split(RS)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, parents, author, email, time, message] = r.split(US)
      return { hash, parents: parents ? parents.split(' ') : [], author, email, time: Number(time) * 1000, subject: splitMessage(message ?? '').subject }
    })
  const lines = (t: string): string[] => t.split('\n').map((x) => x.trim()).filter(Boolean)
  return { commits, head, compare, outgoing: lines(outgoing), incoming: lines(incoming), ahead: ahead || 0, behind: behind || 0 }
}

export interface CommitDetail extends Commit {
  body: string
  committer: string
  committerTime: number
  files: FileChange[]
}

/** First line = title, the rest = body (lines kept as typed, even without a blank line after the title). */
export function splitMessage(raw: string): { subject: string; body: string } {
  const lines = raw.replace(/\r/g, '').replace(/^\n+|\s+$/g, '').split('\n')
  return { subject: (lines[0] ?? '').trim(), body: lines.slice(1).join('\n').replace(/^\n+/, '').trimEnd() }
}

export async function commitDetail(projectPath: string, hash: string): Promise<CommitDetail> {
  const root = await needRoot(projectPath)
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%B'].join(US)
  const meta = await git(root, ['show', '-s', `--format=${fmt}`, hash])
  const [h, parents, author, email, time, committer, ctime, message] = meta.split(US)
  const { subject, body } = splitMessage(message ?? '')
  const ps = parents ? parents.split(' ') : []
  // merge commits: changes relative to the first parent (what the merge brought in)
  const args = ps.length > 1 ? ['diff', '--name-status', '-z', '-M', ps[0], h] : ['diff-tree', '-r', '-z', '-M', '--root', '--no-commit-id', '--name-status', h]
  const files = parseNameStatus(await git(root, args))
  return {
    hash: h, parents: ps, author, email, time: Number(time) * 1000, subject,
    body, committer, committerTime: Number(ctime) * 1000, files
  }
}

export function parseNameStatus(out: string): FileChange[] {
  const p = out.split('\0').filter((s, i, a) => s || i < a.length - 1)
  const files: FileChange[] = []
  for (let i = 0; i < p.length; i++) {
    const code = p[i]
    if (!code) continue
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      files.push({ x: letter, y: ' ', from: p[i + 1], path: p[i + 2] })
      i += 2
    } else {
      files.push({ x: letter, y: ' ', path: p[i + 1] })
      i += 1
    }
  }
  return files
}

/* ---------------- file contents for the diff view ---------------- */

/* ---------------- unified diff (hunks) ---------------- */

export type DiffKind = 'unstaged' | 'untracked' | 'staged' | 'commit'
export interface DiffSpec {
  kind: DiffKind
  path: string
  from?: string
  /** commit kind: the commit and the parent it is compared with (null = root commit) */
  hash?: string
  parent?: string | null
}

function diffArgs(spec: DiffSpec, context: number, ignoreWs: boolean): { args: string[]; okExit?: number[] } {
  const common = [`-U${context}`, '--no-color', '--no-ext-diff', ...(ignoreWs ? ['-w'] : [])]
  const paths = ['--', spec.path, ...(spec.from ? [spec.from] : [])]
  switch (spec.kind) {
    case 'unstaged':
      return { args: ['diff', ...common, ...paths] }
    case 'untracked':
      // exit code 1 just means "there are differences"
      return { args: ['diff', '--no-index', ...common, '--', '/dev/null', spec.path], okExit: [1] }
    case 'staged':
      return { args: ['diff', '--cached', '-M', ...common, ...paths] }
    case 'commit':
      return spec.parent
        ? { args: ['diff', '-M', ...common, spec.parent, spec.hash!, ...paths] }
        : { args: ['show', '--format=', ...common, spec.hash!, ...paths] }
  }
}

/** Unified diff text for one file (decoded as UTF-8 for display). */
export async function diffText(projectPath: string, spec: DiffSpec, context: number, ignoreWs: boolean): Promise<string> {
  const root = await needRoot(projectPath)
  const { args, okExit } = diffArgs(spec, context, ignoreWs)
  return git(root, args, { okExit })
}

/** Split a unified diff into its file header and hunks (works on raw latin1 text too). */
function splitHunks(diff: string): { header: string[]; hunks: string[][] } {
  const lines = diff.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const header: string[] = []
  const hunks: string[][] = []
  for (const l of lines) {
    if (l.startsWith('@@')) hunks.push([l])
    else if (hunks.length) hunks[hunks.length - 1].push(l)
    else header.push(l)
  }
  return { header, hunks }
}

/**
 * Stage / unstage / discard one hunk (Sourcetree "코드뭉치").
 * The diff is regenerated as raw bytes so non-UTF-8 files and CRLF survive the round trip,
 * and the hunk is matched by its "@@ ... @@" header to make sure it did not change meanwhile.
 */
export async function applyHunk(
  projectPath: string,
  spec: DiffSpec,
  context: number,
  index: number,
  headerLine: string,
  action: 'stage' | 'unstage' | 'discard',
  source = 'user'
): Promise<void> {
  const root = await needRoot(projectPath)
  const { args, okExit } = diffArgs(spec, context, false)
  const raw = await git(root, args, { okExit, raw: true })
  const { header, hunks } = splitHunks(raw)
  const hunk = hunks[index]
  const norm = (h: string): string => h.replace(/ @@.*$/, ' @@')
  if (!hunk || norm(Buffer.from(hunk[0], 'latin1').toString('utf-8')) !== norm(headerLine)) {
    throw new GitError('파일이 그 사이에 바뀌었습니다. 새로고침 후 다시 시도하세요.')
  }
  const patch = [...header, ...hunk].join('\n') + '\n'
  const applyArgs =
    action === 'stage' ? ['apply', '--cached', '--whitespace=nowarn', '-'] :
    action === 'unstage' ? ['apply', '--cached', '-R', '--whitespace=nowarn', '-'] :
    ['apply', '-R', '--whitespace=nowarn', '-']
  await git(root, applyArgs, { input: patch, raw: true })
  publish(`git.hunk.${action}`, { path: spec.path, hunk: headerLine }, source)
}

/**
 * Content of a file at a revision. rev: "WORKTREE" (disk), "INDEX" (staged), or a commit-ish.
 * Returns null when the file does not exist there; `binary` when it is not text.
 */
export async function fileAt(projectPath: string, rev: string, path: string): Promise<{ text: string | null; binary: boolean }> {
  const root = await needRoot(projectPath)
  let buf: Buffer
  try {
    if (rev === 'WORKTREE') {
      buf = readFileSync(join(root, path))
    } else {
      const spec = rev === 'INDEX' ? `:${path}` : `${rev}:${path}`
      buf = Buffer.from(await git(root, ['show', spec], { raw: true }), 'latin1')
    }
  } catch {
    return { text: null, binary: false }
  }
  if (buf.subarray(0, 8000).includes(0)) return { text: null, binary: true }
  return { text: buf.toString('utf-8'), binary: false }
}

/* ---------------- write operations ---------------- */

export async function stage(projectPath: string, paths: string[], source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  try {
    await git(root, ['add', '-A', '--', ...paths])
  } catch (e) {
    // A file already tracked inside a folder that .gitignore excludes (added once with -f):
    // `add -A` stages it but still exits 1 with "paths are ignored". `add -u` stages tracked
    // files without that check, so the stage itself succeeds.
    if (!/ignored by one of your \.gitignore files/i.test(String((e as Error)?.message ?? e))) throw e
    await git(root, ['add', '-u', '--', ...paths])
  }
  publish('git.stage', { paths }, source)
}

export async function unstage(projectPath: string, paths: string[], source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  const hasHead = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false)
  if (hasHead) await git(root, ['reset', '-q', 'HEAD', '--', ...paths])
  else await git(root, ['rm', '--cached', '-r', '-q', '--', ...paths])
  publish('git.unstage', { paths }, source)
}

/** Throw away worktree changes. Untracked files go to the recycle bin, not deleted for good. */
export async function discard(projectPath: string, files: { path: string; untracked: boolean }[], source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  const tracked = files.filter((f) => !f.untracked).map((f) => f.path)
  if (tracked.length) await git(root, ['checkout', '--', ...tracked])
  for (const f of files.filter((f) => f.untracked)) await shell.trashItem(join(root, f.path))
  publish('git.discard', { paths: files.map((f) => f.path) }, source)
}

export async function commit(projectPath: string, message: string, amend: boolean, source = 'user'): Promise<string> {
  const root = await needRoot(projectPath)
  if (!message.trim()) throw new GitError('커밋 메시지를 입력하세요')
  await git(root, ['commit', ...(amend ? ['--amend'] : []), '-F', '-'], { input: message })
  const hash = (await git(root, ['rev-parse', 'HEAD'])).trim()
  publish('git.commit', { hash, message: message.split('\n')[0], amend }, source)
  return hash
}

export async function checkout(projectPath: string, target: string, source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  // "origin/feature" with no local "feature": create a tracking branch
  const { refs: list } = await refs(projectPath)
  const remote = list.find((r) => r.kind === 'remote' && r.name === target)
  if (remote) {
    const local = target.slice(target.indexOf('/') + 1)
    if (list.some((r) => r.kind === 'local' && r.name === local)) await git(root, ['checkout', local])
    else await git(root, ['checkout', '--track', target])
  } else {
    await git(root, ['checkout', target])
  }
  publish('git.checkout', { target }, source)
}

export async function createBranch(projectPath: string, name: string, start: string | null, doCheckout: boolean, source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  if (!/^[^\s~^:?*[\\]+$/.test(name)) throw new GitError('브랜치 이름에 쓸 수 없는 문자가 있습니다')
  await git(root, doCheckout ? ['checkout', '-b', name, ...(start ? [start] : [])] : ['branch', name, ...(start ? [start] : [])])
  publish('git.branch.create', { name, start, checkout: doCheckout }, source)
}

/** Recently checked-out branches, newest first (from the HEAD reflog, like IntelliJ's "Recent"). */
export async function recentBranches(projectPath: string, max = 8): Promise<string[]> {
  const root = await needRoot(projectPath)
  const out = await git(root, ['reflog', '-n300', '--format=%gs']).catch(() => '')
  const seen: string[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^checkout: moving from (.+) to (.+)$/)
    if (!m) continue
    for (const name of [m[2], m[1]]) if (!seen.includes(name) && !/^[0-9a-f]{40}$/.test(name)) seen.push(name)
    if (seen.length >= max + 1) break
  }
  return seen.slice(0, max + 1)
}

export async function renameBranch(projectPath: string, from: string, to: string, source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  if (!/^[^\s~^:?*[\\]+$/.test(to)) throw new GitError('브랜치 이름에 쓸 수 없는 문자가 있습니다')
  await git(root, ['branch', '-m', from, to])
  publish('git.branch.rename', { from, to }, source)
}

/** Browser page of a remote repository (https), from an https or ssh remote URL. */
export function webUrl(remoteUrl: string): string | null {
  let u = remoteUrl.trim().replace(/\.git$/, '')
  const ssh = u.match(/^(?:ssh:\/\/)?[^@/]+@([^:/]+)(?::\d+)?[:/](.+)$/)
  if (ssh && !/^https?:/.test(u)) u = `https://${ssh[1]}/${ssh[2]}`
  if (!/^https?:\/\//.test(u)) return null
  return u.replace(/\/\/[^@/]+@/, '//') // drop credentials embedded in the URL
}

/**
 * Open the "new merge request" page (GitLab) / compare page (GitHub, Bitbucket) in the browser.
 * The branch must already be on the remote.
 */
export async function openMergeRequest(projectPath: string, branch: string, target: string | null, source = 'user'): Promise<string> {
  const root = await needRoot(projectPath)
  const up = await git(root, ['rev-parse', '--abbrev-ref', `${branch}@{u}`]).then((s) => s.trim(), () => null)
  if (!up) throw new GitError(`'${branch}' 이(가) 아직 원격에 없습니다. 먼저 푸시하세요.`)
  const remote = up.slice(0, up.indexOf('/'))
  const remoteBranch = up.slice(remote.length + 1)
  const web = webUrl(await git(root, ['remote', 'get-url', remote]))
  if (!web) throw new GitError('원격 주소를 웹 주소로 바꿀 수 없습니다')
  const e = encodeURIComponent
  let url: string
  if (/github\.com/i.test(web)) url = `${web}/compare/${target ? `${e(target)}...` : ''}${e(remoteBranch)}?expand=1`
  else if (/bitbucket/i.test(web)) url = `${web}/pull-requests/new?source=${e(remoteBranch)}${target ? `&dest=${e(target)}` : ''}`
  else url = `${web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${e(remoteBranch)}${target ? `&merge_request%5Btarget_branch%5D=${e(target)}` : ''}`
  await shell.openExternal(url)
  publish('git.mr.open', { branch: remoteBranch, target, remote }, source)
  return url
}

export async function deleteBranch(projectPath: string, name: string, force: boolean, source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  await git(root, ['branch', force ? '-D' : '-d', name])
  publish('git.branch.delete', { name, force }, source)
}

export async function merge(projectPath: string, name: string, source = 'user'): Promise<string> {
  const root = await needRoot(projectPath)
  try {
    const out = await git(root, ['merge', '--no-edit', name])
    publish('git.merge', { name, ok: true }, source)
    return out.trim()
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e)
    publish('git.merge', { name, ok: false, message }, source)
    throw conflictError(e)
  }
}

/** git's English conflict output -> a Korean hint (the full text stays in the event log). */
function conflictError(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e)
  return /CONFLICT|Automatic merge failed|could not apply/i.test(msg)
    ? new GitError('충돌이 생겼습니다. Git 화면에서 충돌 파일을 해결하고 스테이지한 뒤 커밋하세요 (취소하려면 abort).')
    : e
}

export async function abortOperation(projectPath: string, source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  const st = repoState(root)
  const cmd = st === 'MERGING' ? ['merge', '--abort'] : st === 'REBASING' ? ['rebase', '--abort'] : st === 'CHERRY-PICKING' ? ['cherry-pick', '--abort'] : st === 'REVERTING' ? ['revert', '--abort'] : null
  if (!cmd) return
  await git(root, cmd)
  publish('git.abort', { state: st }, source)
}

export async function fetchAll(projectPath: string, source = 'user'): Promise<string> {
  const root = await needRoot(projectPath)
  publish('git.fetch', {}, source)
  return gitRemote(root, ['fetch', '--all', '--prune', '--progress'], 'fetch', source)
}

export async function pull(projectPath: string, source = 'user'): Promise<string> {
  const root = await needRoot(projectPath)
  publish('git.pull', {}, source)
  return gitRemote(root, ['pull', '--no-edit', '--progress'], 'pull', source).catch((e) => {
    throw conflictError(e)
  })
}

export async function push(projectPath: string, force: boolean, source = 'user'): Promise<string> {
  const root = await needRoot(projectPath)
  const st = await status(projectPath)
  if (!st?.branch || st.detached) throw new GitError('푸시할 브랜치가 없습니다 (detached HEAD)')
  const args = ['push', '--progress', ...(force ? ['--force-with-lease'] : [])]
  if (!st.upstream) {
    const { remotes } = await refs(projectPath)
    if (!remotes.length) throw new GitError('원격 저장소(remote)가 없습니다')
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]
    args.push('-u', remote, st.branch)
  }
  publish('git.push', { branch: st.branch, force, setUpstream: !st.upstream }, source)
  return gitRemote(root, args, 'push', source)
}

export async function stashPush(projectPath: string, message: string, source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  await git(root, ['stash', 'push', '-u', ...(message.trim() ? ['-m', message.trim()] : [])])
  publish('git.stash.push', { message }, source)
}

export async function stashAction(projectPath: string, action: 'pop' | 'apply' | 'drop', index: number, source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  await git(root, ['stash', action, `stash@{${index}}`]).catch((e) => {
    throw conflictError(e)
  })
  publish(`git.stash.${action}`, { index }, source)
}

export async function resetTo(projectPath: string, hash: string, mode: 'soft' | 'mixed' | 'hard', source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  await git(root, ['reset', `--${mode}`, hash])
  publish('git.reset', { hash, mode }, source)
}

export async function revert(projectPath: string, hash: string, source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  await git(root, ['revert', '--no-edit', hash]).catch((e) => {
    throw conflictError(e)
  })
  publish('git.revert', { hash }, source)
}

export async function cherryPick(projectPath: string, hash: string, source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  await git(root, ['cherry-pick', hash]).catch((e) => {
    throw conflictError(e)
  })
  publish('git.cherryPick', { hash }, source)
}

export async function init(projectPath: string, source = 'user'): Promise<void> {
  await git(projectPath, ['init'])
  rootCache.delete(projectPath)
  publish('git.init', { path: projectPath }, source)
  watchRepo(projectPath)
}

/* ---------------- .git watchers (one per project open in a window) ---------------- */

const INTERESTING = /^(HEAD|index|packed-refs|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|refs[\\/].*|logs[\\/]HEAD)$/
const gitWatchers = new Map<string, { w: FSWatcher; timer?: ReturnType<typeof setTimeout> }>()

async function watchRepo(projectPath: string): Promise<void> {
  const k = projectPath.toLowerCase()
  gitWatchers.get(k)?.w.close()
  gitWatchers.delete(k)
  rootCache.delete(projectPath)
  const root = await repoRoot(projectPath)
  if (!root) return
  try {
    const entry: { w: FSWatcher; timer?: ReturnType<typeof setTimeout> } = {
      w: watch(gitDir(root), { recursive: true }, (_ev, file) => {
        if (!file || !INTERESTING.test(file) || file.endsWith('.lock')) return
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => publish('git.changed', { file }, 'system', projectPath), 300)
      })
    }
    gitWatchers.set(k, entry)
  } catch {
    /* no watcher - the view still refreshes on focus / actions */
  }
}

/** Keep one .git watcher per project that some window shows. */
export function syncGitWatchers(): void {
  const open = new Map<string, string>()
  for (const w of allWindows()) if (w.project) open.set(w.project.toLowerCase(), w.project)
  for (const [k, e] of gitWatchers) {
    if (open.has(k)) continue
    e.w.close()
    gitWatchers.delete(k)
  }
  for (const [k, dir] of open) if (!gitWatchers.has(k)) watchRepo(dir)
}

/* ------------------------------------------------------------------ conflict resolver */

/** what is being merged in (the "theirs" side), for labels */
async function incomingName(root: string): Promise<string> {
  const d = gitDir(root)
  for (const head of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (!existsSync(join(d, head))) continue
    if (head === 'MERGE_HEAD') {
      try {
        const msg = readFileSync(join(d, 'MERGE_MSG'), 'utf-8').split('\n')[0]
        const m = msg.match(/Merge (?:remote-tracking )?branch(?:es)? '([^']+)'/)
        if (m) return m[1]
      } catch {
        /* no message */
      }
    }
    const n = await git(root, ['name-rev', '--name-only', '--no-undefined', head]).then((s) => s.trim(), () => '')
    return n || head
  }
  return '상대 쪽'
}

export interface ConflictVersions {
  path: string
  /** null: the file does not exist on that side (added / deleted) */
  base: string | null
  ours: string | null
  theirs: string | null
  binary: boolean
  oursLabel: string
  theirsLabel: string
}

/** The three versions of a conflicted file (index stages 1 base, 2 ours, 3 theirs). */
export async function conflictVersions(projectPath: string, path: string): Promise<ConflictVersions> {
  const root = await needRoot(projectPath)
  const stage = async (n: number): Promise<{ text: string | null; binary: boolean }> => {
    try {
      const buf = Buffer.from(await git(root, ['show', `:${n}:${path}`], { raw: true }), 'latin1')
      if (buf.subarray(0, 8000).includes(0)) return { text: null, binary: true }
      return { text: buf.toString('utf-8'), binary: false }
    } catch {
      return { text: null, binary: false }
    }
  }
  const [b, o, t] = await Promise.all([stage(1), stage(2), stage(3)])
  const st = await status(projectPath)
  const branch = st?.branch ?? 'HEAD'
  // rebase: "ours" is the branch being rebased onto, "theirs" the commit being replayed
  const rebasing = st?.state === 'REBASING'
  const incoming = await incomingName(root)
  return {
    path,
    base: b.text,
    ours: o.text,
    theirs: t.text,
    binary: b.binary || o.binary || t.binary,
    oursLabel: rebasing ? `리베이스 대상 (${incoming})` : `내 쪽 (${branch})`,
    theirsLabel: rebasing ? `내 커밋 (${branch})` : `가져오는 쪽 (${incoming})`
  }
}

/** Save the resolved content (null = delete the file) and mark it resolved (git add / rm). */
export async function resolveConflict(projectPath: string, path: string, content: string | null, source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  const full = join(root, path)
  if (content === null) {
    await git(root, ['rm', '-q', '--', path]).catch(() => git(root, ['add', '-A', '--', path]))
  } else {
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf-8')
    await git(root, ['add', '--', path])
  }
  publish('git.conflict.resolved', { path, deleted: content === null }, source)
}

/** All conflicts resolved: finish the merge / cherry-pick / revert with its prepared message. */
export async function finishMerge(projectPath: string, source = 'user'): Promise<string> {
  const root = await needRoot(projectPath)
  const st = await status(projectPath)
  if (st?.conflicts.length) throw new GitError(`아직 해결하지 않은 충돌 파일이 ${st.conflicts.length}개 있습니다`)
  if (st?.state === 'REBASING') {
    await git(root, ['-c', 'core.editor=true', 'rebase', '--continue'])
  } else {
    await git(root, ['commit', '--no-edit'])
  }
  publish('git.merge.finish', { state: st?.state ?? null }, source)
  return (await git(root, ['rev-parse', 'HEAD'])).trim()
}

/** Binary / whole-file conflicts: take one side as it is (git checkout --ours / --theirs) and stage it. */
export async function checkoutSide(projectPath: string, path: string, side: 'ours' | 'theirs', source = 'user'): Promise<void> {
  const root = await needRoot(projectPath)
  await git(root, ['checkout', `--${side}`, '--', path])
  await git(root, ['add', '--', path])
  publish('git.conflict.resolved', { path, side }, source)
}
