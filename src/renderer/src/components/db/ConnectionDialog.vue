<script setup lang="ts">
/** New / edit DB connection (IntelliJ "Data Sources and Drivers", the parts that matter). */
import { ref, computed, watch, onMounted } from 'vue'
import Sheet from '../Sheet.vue'
import { store } from '../../store'
import { toast } from '../../ide'
import { db, KINDS, DEFAULT_PORT, loadConnections, toggleConn, rememberTypedPassword, type DbConn, type DbKind } from '../../db'

const c = ref<DbConn>({ ...db.editing! })
const isNew = !c.value.id
const password = ref('')
/** an existing stored password is kept unless a new one is typed */
const keepStored = computed(() => !isNew && !!db.editing?.hasPassword && !password.value)
const testing = ref(false)
const testMsg = ref<{ ok: boolean; text: string } | null>(null)
const oracleClient = ref<string | null>('')

onMounted(async () => {
  oracleClient.value = await window.api.db.oracleClient()
})

watch(
  () => c.value.kind,
  (k, old) => {
    if (!old || c.value.port === DEFAULT_PORT[old]) c.value.port = DEFAULT_PORT[k]
    testMsg.value = null
  }
)

const dbLabel = computed(() => {
  switch (c.value.kind) {
    case 'oracle':
      return c.value.sid ? 'SID' : '서비스 이름'
    case 'mysql':
    case 'mariadb':
      return '기본 스키마'
    default:
      return '데이터베이스'
  }
})
const dbPlaceholder = computed(() => {
  switch (c.value.kind) {
    case 'oracle':
      return c.value.sid ? 'XE, ORCL' : 'XEPDB1, ORCLPDB, ...'
    case 'postgres':
      return 'postgres'
    case 'mssql':
      return 'master'
    default:
      return '(비우면 서버 기본값)'
  }
})
const url = computed(() => {
  const x = c.value
  const h = `${x.host || 'localhost'}:${x.port || DEFAULT_PORT[x.kind]}`
  switch (x.kind) {
    case 'oracle':
      return x.sid ? `jdbc:oracle:thin:@${h}:${x.database}` : `jdbc:oracle:thin:@//${h}/${x.database}`
    case 'mssql':
      return `jdbc:sqlserver://${h}${x.database ? ';databaseName=' + x.database : ''}`
    case 'postgres':
      return `jdbc:postgresql://${h}/${x.database || 'postgres'}`
    default:
      return `jdbc:${x.kind}://${h}/${x.database}`
  }
})

/** Paste a JDBC URL (from a properties / context.xml file) to fill host, port and database. */
function pasteUrl(e: ClipboardEvent): void {
  const t = e.clipboardData?.getData('text')?.trim() ?? ''
  const m =
    t.match(/^jdbc:(mysql|mariadb|postgresql):\/\/([^:/?;]+)(?::(\d+))?\/?([^?;]*)/i) ??
    t.match(/^jdbc:(sqlserver):\/\/([^:;\\]+)(?::(\d+))?(?:.*databaseName=([^;]+))?/i) ??
    t.match(/^jdbc:(oracle):thin:@\/?\/?([^:/]+):(\d+)([:/])(.+)$/i)
  if (!m) return
  e.preventDefault()
  const k = m[1].toLowerCase()
  const kind: DbKind = k === 'postgresql' ? 'postgres' : k === 'sqlserver' ? 'mssql' : (k as DbKind)
  c.value.kind = kind
  c.value.host = m[2]
  if (kind === 'oracle') {
    c.value.port = Number(m[3])
    c.value.sid = m[4] === ':'
    c.value.database = m[5]
  } else {
    c.value.port = Number(m[3]) || DEFAULT_PORT[kind]
    c.value.database = m[4] ?? ''
  }
}

const valid = computed(() => !!c.value.host.trim() && !!c.value.user.trim() && (c.value.kind !== 'oracle' || !!c.value.database.trim()))

const pw = (): string | null => (keepStored.value ? null : password.value)

async function test(): Promise<void> {
  testing.value = true
  testMsg.value = null
  try {
    const v = await window.api.db.test({ ...c.value }, pw())
    testMsg.value = { ok: true, text: `연결 성공 · ${v}` }
  } catch (e) {
    testMsg.value = { ok: false, text: (e as Error).message }
  } finally {
    testing.value = false
  }
}

async function pickOracleClient(): Promise<void> {
  const d = await window.api.db.pickFolder('Oracle Client 폴더 (oci.dll 이 있는 폴더)')
  if (d) {
    oracleClient.value = d
    await window.api.db.setOracleClient(d)
  }
}

async function save(): Promise<void> {
  try {
    const saved = (await window.api.db.save({ ...c.value, hasPassword: undefined, connected: undefined }, c.value.savePassword ? pw() : null)) as unknown as DbConn
    if (!c.value.savePassword && password.value) rememberTypedPassword(saved.id, password.value)
    await loadConnections()
    store.dialog = null
    db.editing = null
    toast(`'${saved.name}' 연결을 저장했습니다`, 'ok')
    db.selected = saved.id
    void toggleConn(saved.id, true)
  } catch (e) {
    toast(`저장 실패: ${(e as Error).message}`, 'error')
  }
}

function close(): void {
  store.dialog = null
  db.editing = null
}
</script>

<template>
  <Sheet :title="isNew ? '새 DB 연결' : `DB 연결 · ${db.editing?.name}`" :width="620" @close="close">
    <div class="group">
      <div class="kinds">
        <button v-for="k in KINDS" :key="k.kind" class="kind" :class="{ on: c.kind === k.kind }" @click="c.kind = k.kind">{{ k.label }}</button>
      </div>
      <div class="group-box">
        <div class="field">
          <label>이름</label>
          <input v-model="c.name" class="input" :placeholder="`${c.kind}@${c.host || 'localhost'}`" spellcheck="false" />
        </div>
        <div class="field">
          <label>호스트</label>
          <div class="hostrow">
            <input v-model="c.host" class="input mono" placeholder="localhost (JDBC URL 붙여넣기 가능)" spellcheck="false" @paste="pasteUrl" />
            <span class="colon">:</span>
            <input v-model.number="c.port" class="input mono port" type="number" />
          </div>
        </div>
        <div class="field">
          <label>{{ dbLabel }}</label>
          <div class="hostrow">
            <input v-model="c.database" class="input mono" :placeholder="dbPlaceholder" spellcheck="false" />
            <select v-if="c.kind === 'oracle'" v-model="c.sid" class="input sel">
              <option :value="false">서비스 이름</option>
              <option :value="true">SID</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>사용자</label>
          <input v-model="c.user" class="input mono" spellcheck="false" autocomplete="off" />
        </div>
        <div class="field">
          <label>비밀번호</label>
          <input
            v-model="password"
            class="input mono"
            type="password"
            autocomplete="new-password"
            :placeholder="!isNew && db.editing?.hasPassword ? '저장된 비밀번호 유지 (바꿀 때만 입력)' : ''"
          />
        </div>
        <div class="field">
          <label />
          <div class="checks">
            <label class="check"><input v-model="c.savePassword" type="checkbox" /> 비밀번호 저장 (Windows 계정으로 암호화)</label>
            <label class="check"><input v-model="c.readOnly" type="checkbox" /> 읽기 전용 (SELECT 만 실행 · 운영 DB 권장)</label>
            <label v-if="c.kind === 'mssql'" class="check"><input v-model="c.encrypt" type="checkbox" /> 암호화 연결 (Azure SQL)</label>
          </div>
        </div>
        <div v-if="c.kind === 'oracle'" class="field">
          <label>Oracle Client</label>
          <div class="hostrow">
            <span class="oc">{{ oracleClient || '자동 (PATH 의 oci.dll) · 11g 이하 서버에 필요' }}</span>
            <button class="btn small" @click="pickOracleClient">폴더…</button>
          </div>
        </div>
      </div>
      <p class="hint mono-hint">{{ url }}</p>
      <div v-if="testMsg" class="test" :class="{ ok: testMsg.ok }">{{ testMsg.text }}</div>
    </div>

    <template #footer>
      <button class="btn" :disabled="!valid || testing" @click="test">{{ testing ? '연결 중…' : '연결 테스트' }}</button>
      <span class="grow" />
      <button class="btn" @click="close">취소</button>
      <button class="primary-btn" :disabled="!valid" @click="save">저장</button>
    </template>
  </Sheet>
</template>

<style scoped>
.kinds {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.kind {
  height: 28px;
  padding: 0 12px;
  border-radius: 7px;
  border: 1px solid var(--border-strong);
  color: var(--text);
  font-size: 12.5px;
}
.kind:hover {
  background: var(--hover);
}
.kind.on {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  font-weight: 600;
}
.hostrow {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.hostrow .input {
  flex: 1;
  min-width: 0;
}
.hostrow .port {
  flex: 0 0 90px;
}
.hostrow .sel {
  flex: 0 0 120px;
}
.colon {
  color: var(--text-dim);
}
.checks {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
}
.oc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-dim);
}
.mono-hint {
  font-family: var(--font-code);
  font-size: 11.5px;
  user-select: text;
}
.test {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  white-space: pre-wrap;
  user-select: text;
  color: var(--red);
  background: color-mix(in srgb, var(--red) 10%, transparent);
}
.test.ok {
  color: var(--green);
  background: color-mix(in srgb, var(--green) 10%, transparent);
}
.grow {
  flex: 1;
}
</style>
