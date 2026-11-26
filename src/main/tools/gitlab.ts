/**
 * GitLab merge requests from inside the IDE (no browser): the project comes from the git remote,
 * the user's personal access token (scope "api") is kept encrypted with Windows DPAPI per host.
 *
 * Requests go through Electron's network stack (Windows certificate store), so a company GitLab
 * with an internal CA works the same as in the browser.
 */
import { app, net, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { git, GitError, needRoot, splitMessage, webUrl, parseNameStatus, status } from './git'
import { publish } from '../core/events'

/* ------------------------------------------------------------------ token storage */

const file = (): string => join(app.getPath('appData'), 'mixdog-ide', 'gitlab.json')

interface Store {
  /** host (https://gitlab.example.com) -> encrypted token (base64) */
  tokens: Record<string, string>
}

function load(): Store {
  try {
    const s = JSON.parse(readFileSync(file(), 'utf-8')) as Store
    s.tokens ??= {}
    return s
  } catch {
    return { tokens: {} }
  }
}

function save(s: Store): void {
  mkdirSync(join(app.getPath('appData'), 'mixdog-ide'), { recursive: true })
  writeFileSync(file(), JSON.stringify(s, null, 2), 'utf-8')
}

function tokenOf(host: string): string | null {
  const enc = load().tokens[host.toLowerCase()]
  if (!enc) return null
  try {
    return enc.startsWith('plain:') ? Buffer.from(enc.slice(6), 'base64').toString() : safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ API */

export class GitLabError extends Error {
  constructor(
    message: string,
    public status = 0
  ) {
    super(message)
  }
}

async function api<T>(host: string, path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const token = init.token ?? tokenOf(host)
  if (!token) throw new GitLabError('GitLab 토큰이 없습니다', 401)
  let res: Response
  try {
    res = await net.fetch(`${host}/api/v4${path}`, {
      method: init.method ?? 'GET',
      headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    })
  } catch (e) {
    throw new GitLabError(`GitLab(${host})에 연결하지 못했습니다: ${(e as Error).message}`)
  }
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* html error page */
  }
  if (!res.ok) {
    const m = (data as { message?: unknown; error?: unknown } | null)?.message ?? (data as { error?: unknown } | null)?.error ?? text.slice(0, 200)
    const msg = typeof m === 'string' ? m : JSON.stringify(m)
    if (res.status === 401) throw new GitLabError('GitLab 토큰이 맞지 않거나 만료됐습니다. 토큰을 다시 등록하세요.', 401)
    if (res.status === 403) throw new GitLabError(`권한이 없습니다 (토큰에 api 권한이 있는지, 이 프로젝트에 MR 을 만들 수 있는지 확인하세요): ${msg}`, 403)
    if (res.status === 404) throw new GitLabError(`GitLab 에서 찾을 수 없습니다 (${path.split('?')[0]}): ${msg}`, 404)
    throw new GitLabError(`GitLab 오류 ${res.status}: ${msg}`, res.status)
  }
  return data as T
}

/** https://gitlab.example.com + group/sub/project from the remote of the branch's upstream (or origin) */
async function remoteOf(root: string, branch: string | null): Promise<{ host: string; project: string; remote: string; remoteBranch: string | null }> {
  const up = branch ? await git(root, ['rev-parse', '--abbrev-ref', `${branch}@{u}`]).then((s) => s.trim(), () => null) : null
  const remote = up ? up.slice(0, up.indexOf('/')) : 'origin'
  const url = await git(root, ['remote', 'get-url', remote]).then((s) => s.trim(), () => '')
  const web = url ? webUrl(url) : null
  if (!web) throw new GitLabError(`원격(${remote}) 주소를 웹 주소로 바꿀 수 없습니다`)
  const m = web.match(/^(https?:\/\/[^/]+)\/(.+)$/)
  if (!m) throw new GitLabError(`GitLab 프로젝트 주소가 아닙니다: ${web}`)
  return { host: m[1].toLowerCase(), project: m[2], remote, remoteBranch: up ? up.slice(remote.length + 1) : null }
}

interface GlUser {
  id: number
  username: string
  name: string
  avatar_url?: string
}

export interface MrInfo {
  host: string
  project: string
  hasToken: boolean
  /** the token's user, null when there is no (valid) token */
  me: GlUser | null
  tokenError?: string
  projectId: number | null
  defaultBranch: string | null
  /** source branch on the remote (null: not pushed yet) */
  remoteBranch: string | null
  /** local branch has commits that are not on the remote yet */
  unpushed: number
  targets: string[]
  title: string
  description: string
  /** an open MR for the same source → target */
  existing: { iid: number; url: string; title: string } | null
  /** link for creating it in the browser instead */
  webNewUrl: string
}

const enc = encodeURIComponent

/** Everything the MR form needs. */
export async function mrInfo(projectPath: string, branch: string, target: string | null): Promise<MrInfo> {
  const root = await needRoot(projectPath)
  const r = await remoteOf(root, branch)
  const remoteBranches = (await git(root, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${r.remote}`]))
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith('/HEAD'))
    .map((s) => s.slice(r.remote.length + 1))
  const unpushed = r.remoteBranch
    ? Number((await git(root, ['rev-list', '--count', `${r.remote}/${r.remoteBranch}..${branch}`]).catch(() => '0')).trim()) || 0
    : 0
  // title / description from the last commit of the branch (first line / the rest)
  const msg = splitMessage(await git(root, ['log', '-1', '--format=%B', branch]).catch(() => ''))
  const info: MrInfo = {
    host: r.host,
    project: r.project,
    hasToken: !!tokenOf(r.host),
    me: null,
    projectId: null,
    defaultBranch: null,
    remoteBranch: r.remoteBranch,
    unpushed,
    targets: remoteBranches.filter((b) => b !== r.remoteBranch),
    title: msg.subject,
    description: msg.body,
    existing: null,
    webNewUrl: `${r.host}/${r.project}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${enc(r.remoteBranch ?? branch)}${target ? `&merge_request%5Btarget_branch%5D=${enc(target)}` : ''}`
  }
  if (!info.hasToken) return info
  try {
    info.me = await api<GlUser>(r.host, '/user')
    const p = await api<{ id: number; default_branch: string }>(r.host, `/projects/${enc(r.project)}`)
    info.projectId = p.id
    info.defaultBranch = p.default_branch
    const tgt = target ?? (remoteBranches.includes('develop') ? 'develop' : p.default_branch)
    if (r.remoteBranch && tgt) {
      const open = await api<{ iid: number; web_url: string; title: string }[]>(
        r.host,
        `/projects/${p.id}/merge_requests?state=opened&source_branch=${enc(r.remoteBranch)}&target_branch=${enc(tgt)}`
      )
      if (open[0]) info.existing = { iid: open[0].iid, url: open[0].web_url, title: open[0].title }
    }
  } catch (e) {
    info.tokenError = (e as Error).message
    if ((e as GitLabError).status === 401) info.me = null
  }
  return info
}

/** a host the MR form got from mrInfo (scheme + host only) */
const cleanHost = (h: string): string => {
  const m = h.trim().toLowerCase().match(/^(https?:\/\/[^/\s]+)\/?$/)
  if (!m) throw new GitLabError(`GitLab 주소가 올바르지 않습니다: ${h}`)
  return m[1]
}

/** Save (and check) a token for a GitLab host. Returns the token's user. */
export async function setToken(hostIn: string, token: string): Promise<GlUser> {
  const host = cleanHost(hostIn)
  const me = await api<GlUser>(host, '/user', { token: token.trim() })
  const s = load()
  s.tokens[host] = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token.trim()).toString('base64') : 'plain:' + Buffer.from(token.trim()).toString('base64')
  save(s)
  publish('gitlab.token', { host, user: me.username })
  return me
}

export async function forgetToken(hostIn: string): Promise<void> {
  const host = cleanHost(hostIn)
  const s = load()
  delete s.tokens[host]
  save(s)
}

/** Project members matching a search (assignee / reviewer pickers). */
export async function searchUsers(hostIn: string, projectId: number, search: string): Promise<GlUser[]> {
  const host = cleanHost(hostIn)
  const list = await api<GlUser[]>(host, `/projects/${projectId}/users?per_page=20${search ? `&search=${enc(search)}` : ''}`)
  return list.map((u) => ({ id: u.id, username: u.username, name: u.name }))
}

export interface MrCreate {
  branch: string
  target: string
  title: string
  description: string
  draft: boolean
  assigneeId: number | null
  reviewerIds: number[]
  removeSourceBranch: boolean
  squash: boolean
}

/** Create the merge request. Returns its number and web link. */
export async function createMr(projectPath: string, req: MrCreate): Promise<{ iid: number; url: string }> {
  const root = await needRoot(projectPath)
  const r = await remoteOf(root, req.branch)
  if (!r.remoteBranch) throw new GitError(`'${req.branch}' 이(가) 아직 원격에 없습니다. 먼저 Push 하세요.`)
  const p = await api<{ id: number }>(r.host, `/projects/${enc(r.project)}`)
  const title = req.draft && !/^(draft|wip)\s*:/i.test(req.title.trim()) ? `Draft: ${req.title.trim()}` : req.title.trim()
  const body: Record<string, unknown> = {
    source_branch: r.remoteBranch,
    target_branch: req.target,
    title,
    description: req.description,
    remove_source_branch: req.removeSourceBranch,
    squash: req.squash
  }
  if (req.assigneeId) body.assignee_id = req.assigneeId
  if (req.reviewerIds.length) body.reviewer_ids = req.reviewerIds
  const mr = await api<{ iid: number; web_url: string }>(r.host, `/projects/${p.id}/merge_requests`, { method: 'POST', body })
  publish('git.mr.create', { project: r.project, iid: mr.iid, source: r.remoteBranch, target: req.target, url: mr.web_url })
  return { iid: mr.iid, url: mr.web_url }
}

/* ------------------------------------------------------------------ reviewing merge requests */

export interface MrListItem {
  iid: number
  title: string
  author: string
  source: string
  target: string
  draft: boolean
  /** plain Korean status: 병합 가능 / 충돌 / 확인 중 ... */
  status: string
  conflicts: boolean
  url: string
  updated: string
}

interface GlMr {
  iid: number
  title: string
  description: string
  author: GlUser
  assignee: GlUser | null
  reviewers?: GlUser[]
  source_branch: string
  target_branch: string
  draft?: boolean
  work_in_progress?: boolean
  merge_status: string
  detailed_merge_status?: string
  has_conflicts: boolean
  web_url: string
  updated_at: string
  sha: string
  state: string
  head_pipeline?: { status: string; web_url: string } | null
  user?: { can_merge: boolean }
  squash?: boolean
  force_remove_source_branch?: boolean
}

/** detailed_merge_status (GitLab 15.6+) / merge_status → Korean */
function statusText(m: GlMr): string {
  const map: Record<string, string> = {
    mergeable: '병합 가능',
    conflict: '충돌',
    need_rebase: '리베이스 필요',
    not_approved: '승인 필요',
    ci_must_pass: '파이프라인 통과 필요',
    ci_still_running: '파이프라인 실행 중',
    draft_status: 'Draft',
    discussions_not_resolved: '토론 미해결',
    blocked_status: '다른 MR 에 막힘',
    checking: '확인 중',
    unchecked: '확인 전',
    not_open: '닫힘',
    requested_changes: '변경 요청됨'
  }
  if (m.state === 'merged') return '병합됨'
  if (m.state === 'closed') return '닫힘'
  const d = m.detailed_merge_status
  if (d && map[d]) return map[d]
  if (m.has_conflicts) return '충돌'
  if (m.merge_status === 'can_be_merged') return '병합 가능'
  if (m.merge_status === 'cannot_be_merged') return '병합 불가'
  return '확인 중'
}

async function projectFor(projectPath: string): Promise<{ host: string; id: number; remote: string; project: string }> {
  const root = await needRoot(projectPath)
  // the current branch's remote (same as the MR form), origin when that is not a GitLab address
  const r = await remoteOf(root, 'HEAD').catch(() => remoteOf(root, null))
  const p = await api<{ id: number }>(r.host, `/projects/${enc(r.project)}`)
  return { host: r.host, id: p.id, remote: r.remote, project: r.project }
}

/** scope: review = 나에게 리뷰 요청 · assigned = 내가 담당 · mine = 내가 만든 · all = 열린 MR 전부 */
export async function listMrs(projectPath: string, scope: 'review' | 'assigned' | 'mine' | 'all'): Promise<{ host: string; me: GlUser; items: MrListItem[] }> {
  const p = await projectFor(projectPath)
  const me = await api<GlUser>(p.host, '/user')
  const filter = scope === 'review' ? `&reviewer_id=${me.id}` : scope === 'assigned' ? `&assignee_id=${me.id}` : scope === 'mine' ? `&author_id=${me.id}` : ''
  const list = await api<GlMr[]>(p.host, `/projects/${p.id}/merge_requests?state=opened&per_page=50&order_by=updated_at${filter}`)
  return {
    host: p.host,
    me,
    items: list.map((m) => ({
      iid: m.iid,
      title: m.title,
      author: m.author?.name ?? '',
      source: m.source_branch,
      target: m.target_branch,
      draft: !!(m.draft ?? m.work_in_progress),
      status: statusText(m),
      conflicts: m.has_conflicts || m.detailed_merge_status === 'conflict',
      url: m.web_url,
      updated: m.updated_at
    }))
  }
}

export interface MrDetail extends MrListItem {
  description: string
  assignee: string | null
  reviewers: string[]
  sha: string
  pipeline: string | null
  canMerge: boolean
  approvedBy: string[]
  approvedByMe: boolean
  /** approvals still needed (Premium rules), null when the server does not say */
  approvalsLeft: number | null
  squash: boolean
  removeSource: boolean
  /** changed files, from the local repository (after a fetch) */
  files: { path: string; from?: string; x: string }[]
  base: string | null
  head: string | null
  filesError?: string
  remote: string
}

export async function mrDetail(projectPath: string, iid: number): Promise<MrDetail> {
  const root = await needRoot(projectPath)
  const p = await projectFor(projectPath)
  const me = await api<GlUser>(p.host, '/user')
  const m = await api<GlMr>(p.host, `/projects/${p.id}/merge_requests/${iid}`)
  let approvedBy: string[] = []
  let approvedByMe = false
  let approvalsLeft: number | null = null
  try {
    const a = await api<{ approved_by: { user: GlUser }[]; approvals_left?: number }>(p.host, `/projects/${p.id}/merge_requests/${iid}/approvals`)
    approvedBy = a.approved_by.map((x) => x.user.name)
    approvedByMe = a.approved_by.some((x) => x.user.id === me.id)
    approvalsLeft = typeof a.approvals_left === 'number' ? a.approvals_left : null
  } catch {
    /* approvals API not available on this server */
  }
  // changed files: compare the remote branches locally (merge-base..source), like GitLab's "Changes"
  let files: MrDetail['files'] = []
  let base: string | null = null
  let head: string | null = null
  let filesError: string | undefined
  try {
    await git(root, ['fetch', '--no-tags', p.remote, m.source_branch, m.target_branch])
    head = `${p.remote}/${m.source_branch}`
    base = (await git(root, ['merge-base', `${p.remote}/${m.target_branch}`, head])).trim()
    files = parseNameStatus(await git(root, ['diff', '--name-status', '-z', '-M', base, head])).map((f) => ({ path: f.path, from: f.from, x: f.x }))
  } catch (e) {
    filesError = `변경 파일을 가져오지 못했습니다: ${(e as Error).message}`
  }
  return {
    iid: m.iid,
    title: m.title,
    author: m.author?.name ?? '',
    source: m.source_branch,
    target: m.target_branch,
    draft: !!(m.draft ?? m.work_in_progress),
    status: statusText(m),
    conflicts: m.has_conflicts || m.detailed_merge_status === 'conflict',
    url: m.web_url,
    updated: m.updated_at,
    description: m.description ?? '',
    assignee: m.assignee?.name ?? null,
    reviewers: (m.reviewers ?? []).map((r) => r.name),
    sha: m.sha,
    pipeline: m.head_pipeline?.status ?? null,
    canMerge: m.user?.can_merge ?? true,
    approvedBy,
    approvedByMe,
    approvalsLeft,
    squash: !!m.squash,
    removeSource: !!m.force_remove_source_branch,
    files,
    base,
    head,
    filesError,
    remote: p.remote
  }
}

export async function approveMr(projectPath: string, iid: number, approve: boolean, sha?: string): Promise<void> {
  const p = await projectFor(projectPath)
  await api(p.host, `/projects/${p.id}/merge_requests/${iid}/${approve ? 'approve' : 'unapprove'}`, { method: 'POST', body: approve && sha ? { sha } : {} })
  publish(approve ? 'git.mr.approve' : 'git.mr.unapprove', { project: p.project, iid })
}

export async function mergeMr(projectPath: string, iid: number, opts: { squash: boolean; removeSource: boolean; sha?: string }): Promise<{ state: string }> {
  const p = await projectFor(projectPath)
  const r = await api<{ state: string }>(p.host, `/projects/${p.id}/merge_requests/${iid}/merge`, {
    method: 'PUT',
    body: { squash: opts.squash, should_remove_source_branch: opts.removeSource, ...(opts.sha ? { sha: opts.sha } : {}) }
  })
  publish('git.mr.merge', { project: p.project, iid, state: r.state })
  return { state: r.state }
}

export async function closeMr(projectPath: string, iid: number): Promise<void> {
  const p = await projectFor(projectPath)
  await api(p.host, `/projects/${p.id}/merge_requests/${iid}`, { method: 'PUT', body: { state_event: 'close' } })
  publish('git.mr.close', { project: p.project, iid })
}

/**
 * Resolve an MR's conflicts locally (what IntelliJ does): bring the source branch up to date,
 * merge the target branch into it, and return the conflicted files. After they are resolved the
 * merge is committed and pushed, and GitLab sees the MR as mergeable.
 */
export async function prepareMrMerge(projectPath: string, source: string, target: string): Promise<{ branch: string; conflicts: string[]; merged: boolean }> {
  const root = await needRoot(projectPath)
  const st = await status(projectPath)
  if (!st) throw new GitError('Git 저장소가 아닙니다')
  if (st.state) throw new GitError(`이미 진행 중인 작업이 있습니다 (${st.state}). 먼저 끝내거나 취소하세요.`)
  if (st.staged.length || st.unstaged.some((f) => f.x !== '?')) {
    throw new GitError('커밋하지 않은 변경이 있습니다. 커밋하거나 스태시한 뒤 다시 시도하세요 (충돌 해결을 위해 소스 브랜치로 전환합니다).')
  }
  const { remote } = await remoteOf(root, null)
  await git(root, ['fetch', '--no-tags', remote, source, target])
  const local = await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${source}`]).then(() => true, () => false)
  if (local) {
    await git(root, ['checkout', source])
    // the remote branch may have newer commits (someone else pushed): take them first
    await git(root, ['merge', '--ff-only', `${remote}/${source}`]).catch(() => {
      throw new GitError(`로컬 '${source}' 와 원격 브랜치가 서로 다른 커밋을 갖고 있습니다. 먼저 Pull 로 맞춘 뒤 다시 시도하세요.`)
    })
  } else {
    await git(root, ['checkout', '-b', source, '--track', `${remote}/${source}`])
  }
  publish('git.mr.resolve', { source, target })
  try {
    await git(root, ['merge', '--no-ff', '--no-edit', `${remote}/${target}`])
    return { branch: source, conflicts: [], merged: true }
  } catch (e) {
    const after = await status(projectPath)
    if (after?.conflicts.length) return { branch: source, conflicts: after.conflicts.map((f) => f.path), merged: false }
    throw e
  }
}
