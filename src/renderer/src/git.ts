/**
 * Git view state (GitKraken-style): status, refs, commit graph, selection, diff.
 * All reads/writes go through window.api.git (main/tools/git.ts).
 */
import { reactive, watch } from 'vue'
import { store } from './store'
import { toast, ide } from './ide'
import { confirmSheet, promptText, showError } from './ui'
import { explainGitError } from './giterrors'
import { startTask, endTask } from './tasks'
import { showTool } from './layout'

export interface FileChange {
  path: string
  from?: string
  x: string
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
  state: string | null
}
export interface RefInfo {
  name: string
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
export interface Commit {
  hash: string
  parents: string[]
  author: string
  email: string
  time: number
  subject: string
}
export interface CommitDetail extends Commit {
  body: string
  committer: string
  committerTime: number
  files: FileChange[]
}
/** One graph row: node lane + lane snapshots above / below the node. */
export interface GraphRow {
  commit: Commit
  col: number
  before: (string | null)[]
  after: (string | null)[]
  /** lanes the node connects down to (first parent first) */
  down: number[]
  /** lanes merging into the node from above */
  up: number[]
}
export interface DiffTarget {
  path: string
  from?: string
  /** "INDEX" | "WORKTREE" | commit hash; null = file absent (added/deleted) */
  left: string | null
  right: string | null
  title: string
  /** for WIP diffs: which list it came from */
  staged?: boolean
  /** what produces the unified diff for the "변경 부분만" view */
  spec: DiffSpec
}

export interface DiffSpec {
  kind: 'unstaged' | 'untracked' | 'staged' | 'commit'
  path: string
  from?: string
  hash?: string
  parent?: string | null
}

/** Diff view preferences (Sourcetree style), remembered across sessions. */
function pref(key: string, def: string): string {
  try {
    return localStorage.getItem(key) ?? def
  } catch {
    return def
  }
}
export const diffPrefs = reactive({
  /** 'hunks' = only changed parts with context lines, 'full' = whole file side by side */
  mode: pref('mixdog.diffMode', 'hunks') as 'hunks' | 'full',
  context: Number(pref('mixdog.diffContext', '6')),
  ignoreWs: pref('mixdog.diffIgnoreWs', '0') === '1'
})
watch(
  () => ({ ...diffPrefs }),
  (p) => {
    try {
      localStorage.setItem('mixdog.diffMode', p.mode)
      localStorage.setItem('mixdog.diffContext', String(p.context))
      localStorage.setItem('mixdog.diffIgnoreWs', p.ignoreWs ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
)

export const WIP = 'WIP'
const PAGE = 400

export const git = reactive({
  /** null = not loaded / not a repo */
  status: null as GitStatus | null,
  isRepo: true,
  refs: [] as RefInfo[],
  stashes: [] as StashInfo[],
  remotes: [] as string[],
  rows: [] as GraphRow[],
  lanes: 1,
  head: null as string | null,
  limit: PAGE,
  more: false,
  selected: WIP as string,
  detail: null as CommitDetail | null,
  diff: null as DiffTarget | null,
  /** label of the running remote/long operation */
  busy: null as string | null,
  progress: '',
  commitMsg: '',
  amend: false,
  panelW: 340,
  /** bumped after hunk actions so the diff view reloads */
  diffVersion: 0,
  loading: false,
  /** graph scope: every branch, or HEAD + the branch it is compared with (Sourcetree style) */
  scope: (localStorage.getItem('mixdog.gitScope') === 'current' ? 'current' : 'all') as 'all' | 'current',
  /** branch picked to compare with; null = HEAD's upstream */
  compareWith: null as string | null,
  /** what the graph actually compares with (resolved upstream) */
  compare: null as string | null,
  outgoing: new Set<string>(),
  incoming: new Set<string>(),
  compareAhead: 0,
  compareBehind: 0
})

const P = (): string => {
  if (!store.project) throw new Error('열린 프로젝트가 없습니다')
  return store.project.path
}

/* ---------------- loading ---------------- */

let seq = 0
export async function refresh(full = true): Promise<void> {
  if (!store.project) return
  const my = ++seq
  git.loading = true
  try {
    const st = (await window.api.git.status(P())) as unknown as GitStatus | null
    if (my !== seq) return
    git.status = st
    git.isRepo = !!st
    if (!st) {
      git.rows = []
      git.refs = []
      git.stashes = []
      return
    }
    if (!full) return
    const [r, lg] = await Promise.all([
      window.api.git.refs(P()) as unknown as Promise<{ refs: RefInfo[]; stashes: StashInfo[]; remotes: string[] }>,
      window.api.git.log(P(), git.limit, git.scope, git.compareWith) as unknown as Promise<{ commits: Commit[]; head: string | null; compare: string | null; outgoing: string[]; incoming: string[]; ahead: number; behind: number }>
    ])
    if (my !== seq) return
    git.refs = r.refs
    git.stashes = r.stashes
    git.remotes = r.remotes
    git.head = lg.head
    git.compare = lg.compare
    git.outgoing = new Set(lg.outgoing)
    git.incoming = new Set(lg.incoming)
    git.compareAhead = lg.ahead
    git.compareBehind = lg.behind
    git.more = lg.commits.length >= git.limit
    const g = buildGraph(lg.commits)
    git.rows = g.rows
    git.lanes = g.lanes
    if (git.selected !== WIP && !lg.commits.some((c) => c.hash === git.selected)) select(WIP)
  } catch (e) {
    toast(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e), 'error')
  } finally {
    if (my === seq) git.loading = false
  }
}

export function loadMore(): void {
  git.limit += PAGE
  refresh()
}

/** Debounced refresh for file / .git change events. */
let t: ReturnType<typeof setTimeout> | undefined
export function refreshSoon(full = true): void {
  clearTimeout(t)
  t = setTimeout(() => refresh(full), 350)
}

window.api.events.on((ev) => {
  const type = String((ev as { type: string }).type)
  if (type === 'file.changed' || type === 'file.save') refreshSoon(false)
})
window.api.events.onStream((ev) => {
  const e = ev as { type: string; data: Record<string, unknown> }
  if (e.type === 'git.changed') refreshSoon(true)
  else if (e.type === 'git.progress') git.progress = String(e.data.line)
})

/* ---------------- graph layout ---------------- */

/**
 * Assign each commit a lane. `lanes[i]` holds the hash the lane is waiting for.
 * Lanes keep their index while they pass through, so each row can be drawn
 * from its before/after snapshots alone.
 */
export function buildGraph(commits: Commit[]): { rows: GraphRow[]; lanes: number } {
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  let max = 1
  const free = (): number => {
    const i = lanes.indexOf(null)
    return i < 0 ? lanes.length : i
  }
  for (const c of commits) {
    const before = lanes.slice()
    let col = lanes.indexOf(c.hash)
    if (col < 0) {
      col = free()
      lanes[col] = c.hash
    }
    const up: number[] = []
    lanes.forEach((h, i) => {
      if (h === c.hash) {
        up.push(i)
        if (i !== col) lanes[i] = null
      }
    })
    lanes[col] = c.parents[0] ?? null
    const down: number[] = []
    if (c.parents[0]) down.push(col)
    for (const p of c.parents.slice(1)) {
      let j = lanes.indexOf(p)
      if (j < 0) {
        j = free()
        lanes[j] = p
      }
      down.push(j)
    }
    // a first parent already tracked by another lane: merge into it instead of keeping two lanes
    if (c.parents[0]) {
      const other = lanes.findIndex((h, i) => h === c.parents[0] && i !== col)
      if (other >= 0) {
        lanes[col] = null
        down[0] = other
      }
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    rows.push({ commit: c, col, before, after: lanes.slice(), down, up })
    max = Math.max(max, before.length, lanes.length, col + 1)
  }
  return { rows, lanes: max }
}

/* ---------------- selection / diff ---------------- */

export async function select(hash: string): Promise<void> {
  git.selected = hash
  git.diff = null
  git.detail = null
  if (hash === WIP) return
  try {
    const d = (await window.api.git.commit(P(), hash)) as unknown as CommitDetail
    if (git.selected === hash) git.detail = d
  } catch {
    /* toast via event */
  }
}

export function openWipDiff(f: FileChange, staged: boolean): void {
  const untracked = f.x === '?'
  if (staged) {
    git.diff = {
      path: f.path, from: f.from, left: f.x === 'A' ? null : 'HEAD', right: f.x === 'D' ? null : 'INDEX', title: '스테이지됨', staged,
      spec: { kind: 'staged', path: f.path, from: f.from }
    }
  } else {
    git.diff = {
      path: f.path,
      left: untracked ? null : 'INDEX',
      right: f.y === 'D' ? null : 'WORKTREE',
      title: untracked ? '새 파일' : '작업 중 변경',
      staged,
      spec: { kind: untracked ? 'untracked' : 'unstaged', path: f.path }
    }
  }
}

export function openCommitDiff(d: CommitDetail, f: FileChange): void {
  const parent = d.parents[0] ?? null
  git.diff = {
    path: f.path,
    from: f.from,
    left: f.x === 'A' || !parent ? null : parent,
    right: f.x === 'D' ? null : d.hash,
    title: `${d.hash.slice(0, 7)} ${d.subject}`,
    spec: { kind: 'commit', path: f.path, from: f.from, hash: d.hash, parent }
  }
}

/* ---------------- operations ---------------- */

/** Run an operation, report errors, then refresh. */
async function op<T>(label: string | null, fn: () => Promise<T>, okText?: string): Promise<T | null> {
  const taskId = label ? `git:${label}` : null
  if (label) {
    git.busy = label
    git.progress = ''
    startTask({ id: taskId!, title: `Git ${label}`, detail: store.project?.name ?? '' })
  }
  try {
    const r = await fn()
    if (okText) toast(okText, 'ok')
    return r
  } catch (e) {
    showGitError(label ?? '작업', e, () => op(label, fn, okText))
    return null
  } finally {
    if (label) git.busy = null
    if (taskId) endTask(taskId)
    await refresh()
  }
}

/** Error window instead of the short toast: what happened, which files, buttons to fix it. */
export function showGitError(label: string, e: unknown, retry?: () => unknown, again?: () => Promise<unknown>): void {
  // the main process also published the error (short toast): the window replaces it
  if (ide.toast?.kind === 'error') ide.toast = null
  const message = e instanceof Error ? e.message : String(e)
  showError(
    explainGitError(label, message, {
      retry,
      pull: () => pull(),
      showChanges: () => {
        store.mainView = 'git'
        void select(WIP)
      },
      stashAndRetry: again ? () => stashAndRetry(label, again) : undefined
    })
  )
}

/** op() for pull / merge / checkout: on "local changes would be overwritten" the error window offers stash + retry */
async function opRetryable<T>(label: string, fn: () => Promise<T>, okText?: string): Promise<T | null> {
  const taskId = `git:${label}`
  git.busy = label
  git.progress = ''
  startTask({ id: taskId, title: `Git ${label}`, detail: store.project?.name ?? '' })
  try {
    const r = await fn()
    if (okText) toast(okText, 'ok')
    return r
  } catch (e) {
    showGitError(label, e, () => opRetryable(label, fn, okText), () => op(label, fn, okText))
    return null
  } finally {
    git.busy = null
    endTask(taskId)
    await refresh()
  }
}

/** keep my edits aside (stash, new files included), run the operation, put the edits back */
async function stashAndRetry(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await window.api.git.stashPush(P(), `mixdog 자동 보관 (${label} 전)`)
  } catch (e) {
    showGitError('Stash', e)
    await refresh()
    return
  }
  await run()
  await op('Stash pop', () => window.api.git.stash(P(), 'pop', 0), '보관했던 내 수정을 다시 적용했습니다')
}

export const stage = (paths: string[]): Promise<unknown> => op(null, () => window.api.git.stage(P(), paths))
export const unstage = (paths: string[]): Promise<unknown> => op(null, () => window.api.git.unstage(P(), paths))

export async function discard(files: FileChange[]): Promise<void> {
  const n = files.length
  const ok = await confirmSheet(
    '변경 사항 버리기',
    n === 1 ? `'${files[0].path}' 의 변경 사항을 버릴까요?\n새 파일은 휴지통으로 이동합니다.` : `${n}개 파일의 변경 사항을 버릴까요?\n새 파일은 휴지통으로 이동합니다.`,
    '버리기',
    true
  )
  if (!ok) return
  await op(null, () => window.api.git.discard(P(), files.map((f) => ({ path: f.path, untracked: f.x === '?' }))))
  if (git.diff && files.some((f) => f.path === git.diff?.path)) git.diff = null
}

export async function commit(): Promise<void> {
  if (!git.commitMsg.trim()) return toast('커밋 메시지를 입력하세요', 'error')
  if (!git.amend && !git.status?.staged.length) return toast('스테이지된 파일이 없습니다', 'error')
  const r = await op('커밋', () => window.api.git.doCommit(P(), git.commitMsg, git.amend))
  if (r) {
    git.commitMsg = ''
    git.amend = false
    // the diff that was open belongs to what was just committed: back to the commit graph
    git.diff = null
    toast(`커밋됨 ${String(r).slice(0, 7)}`, 'ok')
  }
}

export async function startAmend(on: boolean): Promise<void> {
  git.amend = on
  if (on && !git.commitMsg.trim() && git.head) {
    const d = (await window.api.git.commit(P(), git.head)) as unknown as CommitDetail
    git.commitMsg = d.body ? `${d.subject}\n\n${d.body}` : d.subject
  }
}

export const fetchAll = (): Promise<unknown> => op('Fetch', () => window.api.git.fetch(P()), 'Fetch 완료')
export const pull = (): Promise<unknown> => opRetryable('Pull', () => window.api.git.pull(P()), 'Pull 완료')
export const push = (force = false): Promise<unknown> => op('Push', () => window.api.git.push(P(), force), 'Push 완료')

export async function forcePush(): Promise<void> {
  if (await confirmSheet('강제 푸시', '원격 브랜치를 내 브랜치로 덮어씁니다 (--force-with-lease).\n다른 사람이 그 사이에 푸시한 게 있으면 중단됩니다.', '강제 푸시', true)) await push(true)
}

export async function checkout(target: string): Promise<void> {
  git.compareWith = null // follow the new branch's upstream
  await opRetryable('Checkout', () => window.api.git.checkout(P(), target), `${target} 로 전환됨`)
}

export async function newBranch(start: string | null = null): Promise<void> {
  const r = await promptText('새 브랜치', {
    message: start ? `${start.length === 40 ? start.slice(0, 7) : start} 에서 브랜치를 만듭니다.` : '현재 위치(HEAD)에서 브랜치를 만듭니다.',
    placeholder: 'feature/이름',
    ok: '만들기',
    check: { label: '만든 뒤 바로 전환', value: true }
  })
  if (!r?.value) return
  await op(null, () => window.api.git.createBranch(P(), r.value, start, r.checked), `브랜치 ${r.value} 생성됨`)
}

export async function deleteBranch(name: string): Promise<void> {
  if (!(await confirmSheet('브랜치 삭제', `로컬 브랜치 '${name}' 을(를) 삭제할까요?`, '삭제', true))) return
  try {
    await window.api.git.deleteBranch(P(), name, false)
    toast(`브랜치 ${name} 삭제됨`, 'ok')
  } catch (e) {
    if (String(e).includes('not fully merged') && (await confirmSheet('병합되지 않은 브랜치', `'${name}' 에는 병합되지 않은 커밋이 있습니다.\n그래도 삭제할까요? (git branch -D)`, '강제 삭제', true))) {
      await op(null, () => window.api.git.deleteBranch(P(), name, true), `브랜치 ${name} 삭제됨`)
    }
  }
  await refresh()
}

export async function merge(name: string): Promise<void> {
  const cur = git.status?.branch ?? 'HEAD'
  if (!(await confirmSheet('병합', `'${name}' 을(를) 현재 브랜치 '${cur}' 에 병합할까요?`, '병합'))) return
  await opRetryable('Merge', () => window.api.git.merge(P(), name), '병합 완료')
}

export async function abort(): Promise<void> {
  if (await confirmSheet('작업 취소', `진행 중인 ${git.status?.state ?? ''} 을(를) 취소하고 이전 상태로 되돌릴까요?`, '취소하기', true)) await op(null, () => window.api.git.abort(P()))
}

export async function stashPush(): Promise<void> {
  const r = await promptText('스태시', { message: '작업 중인 변경 사항(새 파일 포함)을 임시 보관합니다.', placeholder: '메시지 (선택)', ok: '스태시' })
  if (!r) return
  await op(null, () => window.api.git.stashPush(P(), r.value), '스태시 저장됨')
}

export async function stashAction(action: 'pop' | 'apply' | 'drop', index: number): Promise<void> {
  if (action === 'drop' && !(await confirmSheet('스태시 삭제', `stash@{${index}} 을(를) 삭제할까요? 되돌릴 수 없습니다.`, '삭제', true))) return
  await op(null, () => window.api.git.stash(P(), action, index), action === 'drop' ? '스태시 삭제됨' : '스태시 적용됨')
}

export async function reset(hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
  const desc = { soft: '변경 내용은 스테이지에 남습니다.', mixed: '변경 내용은 작업 폴더에 남습니다.', hard: '이후의 커밋과 작업 중인 변경이 모두 사라집니다.' }[mode]
  if (!(await confirmSheet(`Reset (${mode})`, `현재 브랜치를 ${hash.slice(0, 7)} 로 되돌립니다.\n${desc}`, '되돌리기', mode === 'hard'))) return
  await op(null, () => window.api.git.reset(P(), hash, mode), '되돌림 완료')
}

export async function revert(hash: string): Promise<void> {
  if (await confirmSheet('커밋 되돌리기 (revert)', `${hash.slice(0, 7)} 의 변경을 취소하는 새 커밋을 만듭니다.`, 'Revert')) await op(null, () => window.api.git.revert(P(), hash), 'Revert 완료')
}

export async function cherryPick(hash: string): Promise<void> {
  if (await confirmSheet('체리픽', `${hash.slice(0, 7)} 을(를) 현재 브랜치에 적용합니다.`, '체리픽')) await op(null, () => window.api.git.cherryPick(P(), hash), '체리픽 완료')
}

export async function initRepo(): Promise<void> {
  await op(null, () => window.api.git.init(P()), 'Git 저장소를 만들었습니다')
}

/* ---------------- helpers ---------------- */

export const STATUS_LABEL: Record<string, string> = {
  M: '수정', A: '추가', D: '삭제', R: '이름 변경', C: '복사', U: '충돌', '?': '새 파일', T: '형식 변경'
}

export function fileLetter(f: FileChange, staged: boolean): string {
  if (f.x === '?') return '?'
  return staged ? f.x : f.y
}

export function refsAt(hash: string): RefInfo[] {
  return git.refs.filter((r) => r.hash === hash)
}

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const LANE_COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#ac8e68', '#5e5ce6', '#66d4cf']
export const laneColor = (i: number): string => LANE_COLORS[i % LANE_COLORS.length]

/* reload when the project changes (the status bar shows the branch even with the Git view closed) */
watch(
  () => store.project?.path,
  () => {
    git.selected = WIP
    git.diff = null
    git.detail = null
    git.limit = PAGE
    git.commitMsg = ''
    git.amend = false
    git.compareWith = null
    refresh()
  },
  { immediate: true }
)

/** Open the Git view (graph in the main area + branch list in the sidebar). */
export function showGitView(): void {
  store.mainView = 'git'
  showTool('git')
  if (store.editorHidden) store.editorHidden = false
}

/** Sourcetree "모든 브랜치 / 현재 브랜치" switch. */
export function setScope(scope: 'all' | 'current'): void {
  git.scope = scope
  try {
    localStorage.setItem('mixdog.gitScope', scope)
  } catch {
    /* ignore */
  }
  git.limit = PAGE
  refresh()
}

/** Compare HEAD with another branch (null = its upstream). */
export function setCompare(name: string | null): void {
  git.compareWith = name
  git.limit = PAGE
  refresh()
}

/** Stage / unstage / discard one hunk of the open diff. */
export async function hunkAction(index: number, header: string, action: 'stage' | 'unstage' | 'discard'): Promise<void> {
  const d = git.diff
  if (!d) return
  if (action === 'discard' && !(await confirmSheet('코드뭉치 버리기', `${d.path} 의 이 변경 부분을 버릴까요?
되돌릴 수 없습니다.`, '버리기', true))) return
  await op(null, () => window.api.git.applyHunk(P(), JSON.parse(JSON.stringify(d.spec)), diffPrefs.context, index, header, action))
  git.diffVersion++
}

/* ---------------- branch popup helpers (IntelliJ style) ---------------- */

export async function renameBranch(name: string): Promise<void> {
  const r = await promptText('브랜치 이름 변경', { message: `'${name}' 의 새 이름`, value: name, ok: '변경' })
  if (!r?.value || r.value === name) return
  await op(null, () => window.api.git.renameBranch(P(), name, r.value), `${r.value} 로 이름을 바꿨습니다`)
}

/** Open the GitLab "new merge request" page for a pushed branch. */
/** MR form inside the IDE (GitLab API); the form also has "브라우저에서 작성" */
export async function openMergeRequest(branch: string, target: string | null = null): Promise<void> {
  const { openMergeRequestForm } = await import('./mr')
  openMergeRequestForm(branch, target)
}

/** Show the graph limited to HEAD vs `name` (Sourcetree "현재 브랜치" + compare). */
export function compareWithCurrent(name: string): void {
  showGitView()
  git.diff = null
  git.scope = 'current'
  try {
    localStorage.setItem('mixdog.gitScope', 'current')
  } catch {
    /* ignore */
  }
  setCompare(name)
}

export async function checkoutRevision(): Promise<void> {
  const r = await promptText('태그 또는 리비전 체크아웃', { placeholder: '태그 이름, 커밋 해시, HEAD~3 …', ok: '체크아웃' })
  if (r?.value) await checkout(r.value)
}

export const recentBranches = (): Promise<string[]> => window.api.git.recent(P())

/** IntelliJ-style branch popup (title bar branch button). */
export const branchPopup = reactive({ open: false, x: 0, y: 0 })
export function toggleBranchPopup(e?: MouseEvent): void {
  if (branchPopup.open) {
    branchPopup.open = false
    return
  }
  const r = (e?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect()
  branchPopup.x = r ? r.left : 120
  branchPopup.y = r ? r.bottom + 4 : 44
  branchPopup.open = true
}
