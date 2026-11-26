<script setup lang="ts">
/**
 * GitLab merge request form inside the IDE (no browser): source → target, title / description
 * (from the last commit), assignee / reviewers, draft, delete source branch, squash.
 * Needs a personal access token (scope "api") once per GitLab host.
 */
import { ref, computed, onMounted, watch } from 'vue'
import Sheet from '../Sheet.vue'
import { mr, closeMergeRequest } from '../../mr'
import { store } from '../../store'
import { toast } from '../../ide'
import { refresh as refreshGit } from '../../git'

interface User {
  id: number
  username: string
  name: string
}
interface Info {
  host: string
  project: string
  hasToken: boolean
  me: User | null
  tokenError?: string
  projectId: number | null
  defaultBranch: string | null
  remoteBranch: string | null
  unpushed: number
  targets: string[]
  title: string
  description: string
  existing: { iid: number; url: string; title: string } | null
  webNewUrl: string
}

const P = (): string => store.project!.path
const branch = computed(() => mr.req?.branch ?? '')
const info = ref<Info | null>(null)
const loading = ref(true)
const error = ref('')
const busy = ref(false)
const created = ref<{ iid: number; url: string } | null>(null)

const target = ref('')
const title = ref('')
const description = ref('')
const draft = ref(false)
const removeSource = ref(true)
const squash = ref(false)
const assignee = ref<User | null>(null)
const reviewers = ref<User[]>([])
const token = ref('')

async function load(keepText = false): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const i = (await window.api.gitlab.info(P(), branch.value, target.value || mr.req?.target || null)) as unknown as Info
    info.value = i
    if (!target.value) target.value = mr.req?.target ?? (i.targets.includes('develop') ? 'develop' : i.defaultBranch ?? i.targets[0] ?? '')
    if (!keepText) {
      title.value = i.title
      description.value = i.description
    }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(() => load())
// another target: check again for an open MR between them
watch(target, (t, old) => old && t !== old && load(true))

const needToken = computed(() => !!info.value && (!info.value.hasToken || !info.value.me))
const tokenUrl = computed(() => (info.value ? `${info.value.host}/-/profile/personal_access_tokens?name=mixdog%20IDE&scopes=api` : ''))

async function saveToken(): Promise<void> {
  if (!token.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    const me = (await window.api.gitlab.setToken(info.value!.host, token.value)) as unknown as User
    token.value = ''
    toast(`GitLab 토큰 등록됨 (${me.name})`, 'ok')
    await load(true)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

async function pushFirst(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await window.api.git.push(P(), false)
    await refreshGit()
    await load(true)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

/* user pickers */
const userQuery = ref('')
const userFor = ref<'assignee' | 'reviewer' | null>(null)
const userResults = ref<User[]>([])
let userTimer: ReturnType<typeof setTimeout> | undefined
function searchUsers(forWhat: 'assignee' | 'reviewer'): void {
  userFor.value = forWhat
  clearTimeout(userTimer)
  userTimer = setTimeout(async () => {
    if (!info.value?.projectId) return
    try {
      userResults.value = (await window.api.gitlab.users(info.value.host, info.value.projectId, userQuery.value.trim())) as unknown as User[]
    } catch (e) {
      error.value = (e as Error).message
    }
  }, 250)
}
function pick(u: User): void {
  if (userFor.value === 'assignee') assignee.value = u
  else if (!reviewers.value.some((r) => r.id === u.id)) reviewers.value.push(u)
  userFor.value = null
  userQuery.value = ''
  userResults.value = []
}

const canCreate = computed(
  () => !!info.value && !needToken.value && !!info.value.remoteBranch && !!target.value && !!title.value.trim() && !info.value.existing && !busy.value
)

async function create(): Promise<void> {
  if (!canCreate.value) return
  busy.value = true
  error.value = ''
  try {
    created.value = await window.api.gitlab.createMr(P(), {
      branch: branch.value,
      target: target.value,
      title: title.value,
      description: description.value,
      draft: draft.value,
      assigneeId: assignee.value?.id ?? null,
      reviewerIds: reviewers.value.map((r) => r.id),
      removeSourceBranch: removeSource.value,
      squash: squash.value
    })
    toast(`MR !${created.value.iid} 을(를) 만들었습니다`, 'ok')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

const open = (url: string): void => void window.api.openExternal(url)
</script>

<template>
  <Sheet :title="created ? 'MR 을 만들었습니다' : '머지 리퀘스트 만들기 (GitLab)'" :width="720" @close="closeMergeRequest">
    <div v-if="loading && !info" class="note">GitLab 정보를 불러오는 중…</div>

    <!-- done -->
    <div v-else-if="created" class="done">
      <p>
        <b>!{{ created.iid }}</b> {{ title }}<br />
        <span class="dim">{{ branch }} → {{ target }}</span>
      </p>
      <a class="link" @click="open(created.url)">{{ created.url }}</a>
    </div>

    <template v-else-if="info">
      <div class="route">
        <span class="dim">From</span> <code>{{ info.remoteBranch ?? branch }}</code>
        <span class="dim">into</span>
        <select v-model="target" class="input sel">
          <option v-for="t in info.targets" :key="t" :value="t">{{ t }}</option>
        </select>
        <span class="proj dim" :title="info.host + '/' + info.project">{{ info.project }}</span>
      </div>

      <!-- token -->
      <div v-if="needToken" class="box warn">
        <p>
          <b>GitLab 개인 액세스 토큰</b>이 필요합니다 (처음 한 번, {{ info.host }}).
          <span v-if="info.tokenError" class="err-inline"><br />{{ info.tokenError }}</span>
        </p>
        <p class="dim">
          GitLab → 프로필 → Preferences → Access Tokens 에서 <b>api</b> 권한으로 만든 토큰을 붙여넣으세요. Windows 계정으로 암호화해 이 PC 에만 저장합니다.
          <a class="link" @click="open(tokenUrl)">토큰 만들기 화면 열기 ↗</a>
        </p>
        <div class="row">
          <input v-model="token" class="input grow" type="password" placeholder="glpat-…" spellcheck="false" @keydown.enter="saveToken" />
          <button class="primary-btn" :disabled="busy || !token.trim()" @click="saveToken">등록</button>
        </div>
      </div>

      <!-- not pushed -->
      <div v-else-if="!info.remoteBranch || info.unpushed" class="box warn row">
        <span class="grow">
          {{ !info.remoteBranch ? `'${branch}' 이(가) 아직 원격에 없습니다.` : `원격에 올리지 않은 커밋이 ${info.unpushed}개 있습니다.` }}
          MR 에 들어가려면 먼저 Push 해야 합니다.
        </span>
        <button class="primary-btn" :disabled="busy" @click="pushFirst">{{ busy ? 'Push 중…' : 'Push' }}</button>
      </div>

      <div v-if="info.existing" class="box row">
        <span class="grow">이미 열린 MR 이 있습니다: <b>!{{ info.existing.iid }}</b> {{ info.existing.title }}</span>
        <button class="btn" @click="open(info.existing.url)">열기 ↗</button>
      </div>

      <div class="field">
        <label>제목</label>
        <div class="grow">
          <input v-model="title" class="input wide" spellcheck="false" />
          <label class="check"><input v-model="draft" type="checkbox" /> Draft (아직 작업 중, 병합 안 되게)</label>
        </div>
      </div>
      <div class="field">
        <label>설명</label>
        <textarea v-model="description" class="input wide desc" spellcheck="false" placeholder="Markdown 사용 가능" />
      </div>
      <div class="field">
        <label>Assignee</label>
        <div class="grow picker">
          <div class="row">
            <span v-if="assignee" class="chip">{{ assignee.name }} <span class="x" @click="assignee = null">✕</span></span>
            <input
              v-if="!assignee"
              v-model="userQuery"
              class="input grow"
              placeholder="이름·아이디 검색"
              :disabled="needToken"
              @focus="searchUsers('assignee')"
              @input="searchUsers('assignee')"
            />
            <a v-if="!assignee && info.me" class="link" @click="assignee = info.me">나에게 할당</a>
          </div>
          <div v-if="userFor === 'assignee' && userResults.length" class="results">
            <div v-for="u in userResults" :key="u.id" class="res" @mousedown.prevent="pick(u)">{{ u.name }} <span class="dim">@{{ u.username }}</span></div>
          </div>
        </div>
      </div>
      <div class="field">
        <label>Reviewer</label>
        <div class="grow picker">
          <div class="row wrap">
            <span v-for="r in reviewers" :key="r.id" class="chip">{{ r.name }} <span class="x" @click="reviewers = reviewers.filter((x) => x.id !== r.id)">✕</span></span>
            <input
              :value="userFor === 'reviewer' ? userQuery : ''"
              class="input grow"
              placeholder="이름·아이디 검색"
              :disabled="needToken"
              @focus="searchUsers('reviewer')"
              @input="(userQuery = ($event.target as HTMLInputElement).value), searchUsers('reviewer')"
            />
          </div>
          <div v-if="userFor === 'reviewer' && userResults.length" class="results">
            <div v-for="u in userResults" :key="u.id" class="res" @mousedown.prevent="pick(u)">{{ u.name }} <span class="dim">@{{ u.username }}</span></div>
          </div>
        </div>
      </div>
      <div class="field">
        <label>병합 옵션</label>
        <div class="grow">
          <label class="check"><input v-model="removeSource" type="checkbox" /> 병합되면 소스 브랜치 삭제</label>
          <label class="check"><input v-model="squash" type="checkbox" /> 커밋 하나로 합치기 (squash)</label>
        </div>
      </div>
    </template>

    <div v-if="error" class="error">{{ error }}</div>

    <template #footer>
      <template v-if="created">
        <button class="btn" @click="closeMergeRequest">닫기</button>
        <button class="primary-btn" @click="open(created.url)">브라우저에서 보기</button>
      </template>
      <template v-else>
        <button v-if="info" class="btn" title="GitLab 웹 화면에서 만들기" @click="open(info.webNewUrl)">브라우저에서 작성 ↗</button>
        <span class="grow" />
        <button class="btn" @click="closeMergeRequest">취소</button>
        <button class="primary-btn" :disabled="!canCreate" @click="create">{{ busy ? '만드는 중…' : 'MR 만들기' }}</button>
      </template>
    </template>
  </Sheet>
</template>

<style scoped>
.note {
  color: var(--text-dim);
  padding: 10px 0;
}
.route {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 12px;
  font-size: 13px;
}
.route code {
  font-family: var(--font-code);
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--surface-2);
}
.sel {
  height: 26px;
  font-family: var(--font-code);
  font-size: 12px;
}
.proj {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
}
.dim {
  color: var(--text-dim);
}
.box {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-2);
  line-height: 1.6;
}
.box p {
  margin: 0 0 6px;
}
.box.warn {
  background: color-mix(in srgb, #d9a400 12%, var(--surface));
}
.err-inline {
  color: var(--red);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row.wrap {
  flex-wrap: wrap;
}
.grow {
  flex: 1;
  min-width: 0;
}
.field {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}
.field > label {
  width: 78px;
  flex-shrink: 0;
  padding-top: 6px;
  font-weight: 600;
  font-size: 12.5px;
  text-align: right;
}
.wide {
  width: 100%;
}
.desc {
  height: 120px;
  resize: vertical;
  font-family: var(--font-code);
  font-size: 12.5px;
  line-height: 1.55;
  padding: 7px 9px;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
  font-size: 12.5px;
  color: var(--text-dim);
}
.picker {
  position: relative;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12.5px;
  white-space: nowrap;
}
.chip .x {
  cursor: pointer;
  opacity: 0.7;
}
.results {
  position: absolute;
  z-index: 5;
  left: 0;
  right: 0;
  top: 100%;
  margin-top: 2px;
  max-height: 200px;
  overflow: auto;
  border-radius: 8px;
  background: var(--elevated);
  box-shadow: var(--shadow);
}
.res {
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12.5px;
}
.res:hover {
  background: var(--hover);
}
.link {
  color: var(--accent);
  cursor: pointer;
  white-space: nowrap;
}
.error {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--red);
  background: color-mix(in srgb, var(--red) 8%, var(--surface));
  white-space: pre-wrap;
  user-select: text;
  font-size: 12.5px;
}
.done p {
  margin: 4px 0 10px;
  line-height: 1.7;
}
</style>
