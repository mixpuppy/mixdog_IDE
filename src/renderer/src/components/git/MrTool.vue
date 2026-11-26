<script setup lang="ts">
/**
 * GitLab merge requests tool window: lists (리뷰 요청 / 내 담당 / 내가 만든 / 전체), detail with
 * approvals, pipeline and changed files (opened in the Git view's diff), and actions:
 * 승인 · 승인 취소 · 병합 · 닫기 · 충돌 해결 (merges the target into the source locally).
 */
import { ref, computed, onMounted, watch } from 'vue'
import Icon from '../Icon.vue'
import ToolBar from '../tools/ToolBar.vue'
import { store } from '../../store'
import { toast } from '../../ide'
import { confirmSheet } from '../../ui'
import { git, refresh as refreshGit, showGitView } from '../../git'
import { openResolver } from '../../conflicts'
import { openMergeRequestForm } from '../../mr'

interface Item {
  iid: number
  title: string
  author: string
  source: string
  target: string
  draft: boolean
  status: string
  conflicts: boolean
  url: string
  updated: string
}
interface Detail extends Item {
  description: string
  assignee: string | null
  reviewers: string[]
  sha: string
  pipeline: string | null
  canMerge: boolean
  approvedBy: string[]
  approvedByMe: boolean
  approvalsLeft: number | null
  squash: boolean
  removeSource: boolean
  files: { path: string; from?: string; x: string }[]
  base: string | null
  head: string | null
  filesError?: string
}

type Scope = 'review' | 'assigned' | 'mine' | 'all'
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'review', label: '리뷰 요청' },
  { id: 'assigned', label: '내 담당' },
  { id: 'mine', label: '내가 만든' },
  { id: 'all', label: '전체' }
]
const P = (): string => store.project!.path
const scope = ref<Scope>((localStorage.getItem('mixdog.mrScope') as Scope) || 'review')
const items = ref<Item[]>([])
const loading = ref(false)
const error = ref('')
const host = ref('')
const hasToken = ref(true)
const token = ref('')
const detail = ref<Detail | null>(null)
const busy = ref('')
const squash = ref(false)
const removeSource = ref(true)

async function loadList(): Promise<void> {
  if (!store.project) return
  loading.value = true
  error.value = ''
  try {
    const info = (await window.api.gitlab.info(P(), git.status?.branch ?? 'HEAD', null)) as unknown as { host: string; hasToken: boolean; me: unknown; tokenError?: string }
    host.value = info.host
    hasToken.value = info.hasToken && !!info.me
    if (!hasToken.value) {
      items.value = []
      if (info.tokenError) error.value = info.tokenError
      return
    }
    const r = (await window.api.gitlab.list(P(), scope.value)) as unknown as { items: Item[] }
    items.value = r.items
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(loadList)
watch(scope, (s) => {
  try {
    localStorage.setItem('mixdog.mrScope', s)
  } catch {
    /* ignore */
  }
  detail.value = null
  void loadList()
})
watch(() => store.project?.path, () => ((detail.value = null), void loadList()))

async function saveToken(): Promise<void> {
  if (!token.value.trim() || !host.value) return
  try {
    await window.api.gitlab.setToken(host.value, token.value)
    token.value = ''
    await loadList()
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function openDetail(iid: number): Promise<void> {
  busy.value = 'detail'
  error.value = ''
  try {
    const d = (await window.api.gitlab.detail(P(), iid)) as unknown as Detail
    detail.value = d
    squash.value = d.squash
    removeSource.value = true
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

/** a changed file in the Git view's diff (merge-base → source branch) */
function openFileDiff(f: Detail['files'][number]): void {
  const d = detail.value
  if (!d?.base || !d.head) return
  showGitView()
  git.diff = {
    path: f.path,
    from: f.from,
    left: f.x === 'A' ? null : d.base,
    right: f.x === 'D' ? null : d.head,
    title: `!${d.iid} ${d.title}`,
    spec: { kind: 'commit', path: f.path, from: f.from, hash: d.head, parent: d.base }
  }
}

async function act(name: string, fn: () => Promise<unknown>, ok: string): Promise<void> {
  if (!detail.value) return
  busy.value = name
  error.value = ''
  try {
    await fn()
    toast(ok, 'ok')
    await openDetail(detail.value.iid)
    void loadList()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

const approve = (on: boolean): Promise<void> =>
  act(on ? 'approve' : 'unapprove', () => window.api.gitlab.approve(P(), detail.value!.iid, on, detail.value!.sha), on ? '승인했습니다' : '승인을 취소했습니다')

async function merge(): Promise<void> {
  const d = detail.value
  if (!d) return
  if (!(await confirmSheet('MR 병합', `!${d.iid} ${d.title}\n${d.source} → ${d.target} 로 병합할까요?${squash.value ? '\n(커밋을 하나로 합침)' : ''}${removeSource.value ? '\n(병합 후 소스 브랜치 삭제)' : ''}`, '병합'))) return
  await act('merge', () => window.api.gitlab.merge(P(), d.iid, { squash: squash.value, removeSource: removeSource.value, sha: d.sha }), `!${d.iid} 을(를) 병합했습니다`)
}

async function closeMr(): Promise<void> {
  const d = detail.value
  if (!d) return
  if (!(await confirmSheet('MR 닫기', `!${d.iid} ${d.title}\n병합하지 않고 닫을까요?`, '닫기', true))) return
  await act('close', () => window.api.gitlab.close(P(), d.iid), `!${d.iid} 을(를) 닫았습니다`)
}

/** IntelliJ way: merge the target into the source branch locally, resolve, commit, push */
async function resolveConflicts(): Promise<void> {
  const d = detail.value
  if (!d) return
  if (
    !(await confirmSheet(
      'MR 충돌 해결',
      `로컬에서 '${d.source}' 브랜치로 전환한 뒤 '${d.target}' 를 병합해 충돌을 해결합니다.\n해결이 끝나면 병합 커밋을 만들어 Push 하면 GitLab 의 충돌 표시가 사라집니다.\n(커밋하지 않은 변경이 있으면 먼저 커밋하거나 스태시해야 합니다)`,
      '시작'
    ))
  )
    return
  busy.value = 'resolve'
  error.value = ''
  try {
    const r = await window.api.gitlab.prepareMerge(P(), d.source, d.target)
    await refreshGit()
    if (r.merged) {
      if (await confirmSheet('충돌 없이 병합됨', `로컬에서는 '${d.target}' 가 충돌 없이 병합됐습니다. 지금 Push 할까요?`, 'Push')) {
        await window.api.git.push(P(), false)
        toast('Push 완료', 'ok')
        await openDetail(d.iid)
      }
    } else openResolver(r.conflicts, r.conflicts[0], { iid: d.iid, source: d.source, target: d.target })
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 3600) return `${Math.round(s / 60)}분 전`
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`
  return `${Math.round(s / 86400)}일 전`
}
const pipelineText: Record<string, string> = { success: '성공', failed: '실패', running: '실행 중', pending: '대기', canceled: '취소됨', skipped: '건너뜀', manual: '수동' }
const statusCls = (s: string): string => (s === '병합 가능' ? 'ok' : s === '충돌' || s === '병합 불가' ? 'bad' : 'wait')
const fileName = (p: string): string => p.split('/').pop() ?? p
const fileDir = (p: string): string => p.split('/').slice(0, -1).join('/')
const openWeb = (url: string): void => void window.api.openExternal(url)
const canApprove = computed(() => !!detail.value && !detail.value.approvedByMe)
</script>

<template>
  <div class="tool">
    <ToolBar>
      <button v-if="detail" class="icon-btn" title="목록으로" @click="detail = null"><Icon name="chevronRight" :size="13" style="transform: rotate(180deg)" /></button>
      <template v-else>
        <button v-for="s in SCOPES" :key="s.id" class="tab" :class="{ on: scope === s.id }" @click="scope = s.id">{{ s.label }}</button>
      </template>
      <span class="grow" />
      <button class="icon-btn" title="새 MR 만들기 (현재 브랜치)" :disabled="!git.status?.branch" @click="git.status?.branch && openMergeRequestForm(git.status.branch)"><Icon name="plus" :size="13" /></button>
      <button class="icon-btn" title="새로고침" @click="detail ? openDetail(detail.iid) : loadList()"><Icon name="refresh" :size="13" /></button>
    </ToolBar>

    <div class="body">
      <!-- token -->
      <div v-if="!hasToken && !loading" class="box">
        <p><b>GitLab 개인 액세스 토큰</b>을 등록하면 MR 을 여기서 보고 승인·병합할 수 있습니다.</p>
        <p class="dim">GitLab → 프로필 → Preferences → Access Tokens 에서 <b>api</b> 권한으로 만드세요. ({{ host }})</p>
        <div class="row">
          <input v-model="token" class="input grow" type="password" placeholder="glpat-…" @keydown.enter="saveToken" />
          <button class="primary-btn" @click="saveToken">등록</button>
        </div>
      </div>

      <!-- list -->
      <template v-else-if="!detail">
        <div v-if="loading" class="note">불러오는 중…</div>
        <div v-else-if="!items.length && !error" class="note">열린 MR 이 없습니다.</div>
        <div v-for="m in items" :key="m.iid" class="item" @click="openDetail(m.iid)">
          <div class="t1">
            <span class="iid">!{{ m.iid }}</span>
            <span v-if="m.draft" class="tag">Draft</span>
            <span class="title">{{ m.title }}</span>
          </div>
          <div class="t2">
            <span class="badge" :class="statusCls(m.status)">{{ m.status }}</span>
            <span class="br">{{ m.source }} → {{ m.target }}</span>
            <span class="grow" />
            <span class="dim">{{ m.author }} · {{ ago(m.updated) }}</span>
          </div>
        </div>
      </template>

      <!-- detail -->
      <div v-else class="detail">
        <div class="t1">
          <span class="iid">!{{ detail.iid }}</span>
          <span v-if="detail.draft" class="tag">Draft</span>
          <span class="title big">{{ detail.title }}</span>
        </div>
        <div class="kv">
          <span class="k">브랜치</span><span><code>{{ detail.source }}</code> → <code>{{ detail.target }}</code></span>
          <span class="k">상태</span><span><span class="badge" :class="statusCls(detail.status)">{{ detail.status }}</span></span>
          <span class="k">작성자</span><span>{{ detail.author }}</span>
          <span class="k">담당</span><span>{{ detail.assignee ?? '없음' }}</span>
          <span class="k">리뷰어</span><span>{{ detail.reviewers.join(', ') || '없음' }}</span>
          <span class="k">승인</span>
          <span>
            {{ detail.approvedBy.length ? detail.approvedBy.join(', ') : '아직 없음' }}
            <span v-if="detail.approvalsLeft" class="dim"> · {{ detail.approvalsLeft }}명 더 필요</span>
          </span>
          <template v-if="detail.pipeline"><span class="k">파이프라인</span><span>{{ pipelineText[detail.pipeline] ?? detail.pipeline }}</span></template>
        </div>

        <div v-if="detail.conflicts" class="conflict">
          <span class="grow">대상 브랜치와 <b>충돌</b>이 있어 병합할 수 없습니다.</span>
          <button class="primary-btn" :disabled="!!busy" @click="resolveConflicts">{{ busy === 'resolve' ? '준비 중…' : '충돌 해결' }}</button>
        </div>

        <div class="actions">
          <button v-if="canApprove" class="btn" :disabled="!!busy" @click="approve(true)">👍 승인</button>
          <button v-else class="btn" :disabled="!!busy" @click="approve(false)">승인 취소</button>
          <button class="primary-btn" :disabled="!!busy || detail.conflicts || !detail.canMerge || detail.draft" :title="detail.draft ? 'Draft 는 병합할 수 없습니다' : !detail.canMerge ? '병합 권한이 없습니다' : ''" @click="merge">
            {{ busy === 'merge' ? '병합 중…' : '병합' }}
          </button>
          <button class="btn" :disabled="!!busy" @click="closeMr">MR 닫기</button>
          <button class="btn" @click="openWeb(detail.url)">웹 ↗</button>
        </div>
        <div class="opts">
          <label><input v-model="squash" type="checkbox" /> 커밋 하나로 합치기</label>
          <label><input v-model="removeSource" type="checkbox" /> 소스 브랜치 삭제</label>
        </div>

        <div v-if="detail.description" class="sec">설명</div>
        <pre v-if="detail.description" class="desc">{{ detail.description }}</pre>

        <div class="sec">변경 파일 {{ detail.files.length }}</div>
        <div v-if="detail.filesError" class="err">{{ detail.filesError }}</div>
        <div v-for="f in detail.files" :key="f.path" class="file" :title="f.path" @click="openFileDiff(f)">
          <span class="x" :class="f.x">{{ f.x }}</span>
          <span class="fname">{{ fileName(f.path) }}</span>
          <span class="dim fdir">{{ fileDir(f.path) }}</span>
        </div>
      </div>
      <div v-if="error" class="err">{{ error }}</div>
    </div>
  </div>
</template>

<style scoped>
.tool {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.tab {
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-dim);
}
.tab.on {
  color: var(--text);
  background: var(--accent-soft);
}
.grow {
  flex: 1;
  min-width: 0;
}
.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0 12px;
}
.note {
  padding: 12px;
  color: var(--text-dim);
}
.box {
  margin: 8px;
  padding: 10px;
  border-radius: 8px;
  background: var(--surface-2);
  line-height: 1.6;
  font-size: 12.5px;
}
.box p {
  margin: 0 0 6px;
}
.row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.dim {
  color: var(--text-dim);
  font-size: 11.5px;
}
.item {
  margin: 0 6px;
  padding: 7px 8px;
  border-radius: 7px;
  cursor: pointer;
}
.item:hover {
  background: var(--hover);
}
.t1 {
  display: flex;
  gap: 6px;
  align-items: baseline;
  min-width: 0;
}
.t2 {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 3px;
  font-size: 11.5px;
}
.iid {
  color: var(--text-dim);
  font-size: 12px;
  flex-shrink: 0;
}
.title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.title.big {
  white-space: normal;
  font-weight: 700;
  font-size: 13px;
}
.tag {
  font-size: 10.5px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--text-dim);
  flex-shrink: 0;
}
.br {
  font-family: var(--font-code);
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
}
.badge.ok {
  color: var(--green);
  background: color-mix(in srgb, var(--green) 14%, transparent);
}
.badge.bad {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 14%, transparent);
}
.badge.wait {
  color: #d9a400;
  background: color-mix(in srgb, #d9a400 14%, transparent);
}
.detail {
  padding: 6px 12px;
}
.kv {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 4px 8px;
  margin: 10px 0;
  font-size: 12px;
}
.k {
  color: var(--text-faint);
}
code {
  font-family: var(--font-code);
  font-size: 11.5px;
}
.conflict {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  background: color-mix(in srgb, var(--red) 10%, var(--surface));
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.opts {
  display: flex;
  gap: 12px;
  margin: 6px 0 4px;
  font-size: 12px;
  color: var(--text-dim);
}
.opts label {
  display: flex;
  align-items: center;
  gap: 4px;
}
.sec {
  margin: 12px 0 4px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-dim);
}
.desc {
  margin: 0;
  padding: 8px;
  border-radius: 6px;
  background: var(--surface-2);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-ui);
  font-size: 12px;
  line-height: 1.55;
  user-select: text;
}
.file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12.5px;
  white-space: nowrap;
}
.file:hover {
  background: var(--hover);
}
.x {
  width: 14px;
  font-weight: 700;
  font-size: 11px;
  color: #d9a400;
}
.x.A {
  color: var(--green);
}
.x.D {
  color: var(--red);
}
.fdir {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.err {
  margin: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--red);
  background: color-mix(in srgb, var(--red) 8%, var(--surface));
  white-space: pre-wrap;
  font-size: 12px;
  user-select: text;
}
</style>
