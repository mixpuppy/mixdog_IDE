<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import Sheet from './Sheet.vue'
import Downloads from './Downloads.vue'
import { store } from '../store'
import { ide, saveSettings, toast } from '../ide'
import { run } from '../commands'
import type { TomcatInfo, RunConfig } from '../types'

const tomcats = ref<TomcatInfo[]>([])
const cfg = ref<RunConfig>(JSON.parse(JSON.stringify(ide.info!.settings.run)))
const detected = ref<string | null>(null)
const menu = ref(false)
const busy = ref(false)
const offline = ref(!!ide.info!.settings.offline)
const goalsLabel = computed(() => ide.info?.settings.buildGoals || ide.info?.build.defaultGoals || 'clean package')

/** Minimum Java per Tomcat major (mirrors main/tools/tomcat.ts). */
const MIN_JAVA: Record<number, number> = { 7: 6, 8: 7, 9: 8, 10: 11, 11: 17, 12: 21 }

async function refresh(): Promise<void> {
  tomcats.value = (await window.api.tomcat.list()) as unknown as TomcatInfo[]
  if (!cfg.value.tomcatHome && tomcats.value.length) cfg.value.tomcatHome = tomcats.value[0].home
}
onMounted(async () => {
  await refresh()
  if (store.project) detected.value = await window.api.project.deployable(store.project.path)
})

const selected = computed(() => tomcats.value.find((t) => t.home === cfg.value.tomcatHome))
const jdkWarning = computed(() => {
  const t = selected.value
  const jdk = ide.info?.jdk
  if (!t || !jdk) return null
  const need = MIN_JAVA[t.major]
  return need && jdk.major < need ? `Tomcat ${t.version} 은 JDK ${need} 이상이 필요합니다. 현재 프로젝트 JDK 는 ${jdk.major} 입니다.` : null
})

async function download(major: number): Promise<void> {
  menu.value = false
  busy.value = true
  try {
    const t = (await window.api.tomcat.download(major)) as unknown as TomcatInfo | null
    await refresh()
    if (t) cfg.value.tomcatHome = t.home
  } catch {
    /* toast via event */
  } finally {
    busy.value = false
  }
}

async function addFolder(): Promise<void> {
  try {
    const t = (await window.api.tomcat.add()) as unknown as TomcatInfo | null
    await refresh()
    if (t) cfg.value.tomcatHome = t.home
  } catch {
    /* toast via event */
  }
}

async function save(andRun = false): Promise<void> {
  if (!ide.info) return
  cfg.value.httpPort = Number(cfg.value.httpPort) || 8080
  cfg.value.debugPort = Number(cfg.value.debugPort) || 5005
  if (!cfg.value.contextPath.startsWith('/')) cfg.value.contextPath = '/' + cfg.value.contextPath
  cfg.value.deployPath = cfg.value.deployPath?.trim() || null
  ide.info.settings.run = cfg.value
  ide.info.settings.offline = offline.value
  await saveSettings()
  store.dialog = null
  if (andRun) run('run.start')
  else toast('실행 구성을 저장했습니다', 'ok')
}
</script>

<template>
  <Sheet title="실행 구성 · Tomcat" :width="680" @close="store.dialog = null">
    <div class="group">
      <div class="group-title">
        <span>Tomcat 서버</span>
        <span class="actions">
          <button class="btn small" @click="addFolder">폴더 추가…</button>
          <span class="menu-wrap">
            <button class="btn small" :disabled="busy" @click="menu = !menu">Tomcat 다운로드 ▾</button>
            <div v-if="menu" class="menu">
              <button @click="download(11)">Tomcat 11 (jakarta, JDK 17+)</button>
              <button @click="download(10)">Tomcat 10.1 (jakarta, JDK 11+)</button>
              <button @click="download(9)">Tomcat 9 (javax, JDK 8+)</button>
            </div>
          </span>
        </span>
      </div>
      <div class="group-box">
        <div
          v-for="t in tomcats"
          :key="t.home"
          class="opt-row selectable"
          :class="{ on: t.home === cfg.tomcatHome }"
          @click="cfg.tomcatHome = t.home"
        >
          <span class="radio" />
          <div class="opt-main">
            <div class="opt-title">
              Tomcat {{ t.version }}
              <span class="tag">{{ t.major >= 10 ? 'jakarta' : 'javax' }}</span>
              <span v-if="t.managed" class="tag accent">IDE 관리</span>
            </div>
            <div class="opt-sub">{{ t.home }}</div>
          </div>
        </div>
        <div v-if="!tomcats.length" class="opt-row">설치된 Tomcat 이 없습니다. 다운로드하거나 폴더를 추가하세요.</div>
      </div>
      <Downloads />
      <div v-if="jdkWarning" class="warn-box">{{ jdkWarning }} 프로젝트 설정에서 JDK 를 바꾸세요.</div>
      <p class="hint">설치된 Tomcat 폴더는 건드리지 않고, 프로젝트마다 별도 실행 폴더(CATALINA_BASE)를 만들어 씁니다.</p>
    </div>

    <div class="group">
      <div class="group-title"><span>배포</span></div>
      <div class="group-box">
        <div class="field">
          <label>컨텍스트 경로</label>
          <input v-model="cfg.contextPath" class="input mono" spellcheck="false" />
        </div>
        <div class="field">
          <label>HTTP 포트</label>
          <input v-model.number="cfg.httpPort" class="input mono" type="number" style="width: 110px" />
        </div>
        <div class="field">
          <label>디버그 포트</label>
          <input v-model.number="cfg.debugPort" class="input mono" type="number" style="width: 110px" />
        </div>
        <div class="field">
          <label>배포 대상</label>
          <input
            v-model="cfg.deployPath"
            class="input mono"
            :placeholder="detected ? `자동: ${detected}` : '자동 (빌드 후 target/ 또는 build/ 에서 찾음)'"
            spellcheck="false"
          />
        </div>
        <div class="field">
          <label>VM 옵션</label>
          <input v-model="cfg.vmOptions" class="input mono" spellcheck="false" />
        </div>
        <div class="field">
          <label>실행 전</label>
          <label class="check"><input v-model="cfg.buildBeforeRun" type="checkbox" /> 빌드 먼저 실행</label>
        </div>
        <div v-if="cfg.buildBeforeRun" class="field">
          <label>빌드 방식</label>
          <div class="modes">
            <label class="check"><input v-model="cfg.fastBuild" type="radio" :value="true" /> 빠른 빌드 (바뀐 것만 컴파일·복사, 인텔리제이 방식)</label>
            <label class="check"><input v-model="cfg.fastBuild" type="radio" :value="false" /> 전체 빌드 ({{ goalsLabel }})</label>
          </div>
        </div>
        <div class="field">
          <label>Maven/Gradle</label>
          <label class="check"><input v-model="offline" type="checkbox" /> 오프라인 (원격 저장소 확인 건너뛰기)</label>
        </div>
      </div>
      <p class="hint">
        빠른 빌드는 clean·war 압축 없이 바뀐 클래스와 웹 파일만 배포 폴더에 복사합니다 (pom.xml 이 바뀌면 배포 폴더를 한 번 새로 만듦).
        오프라인에서 없는 의존성이 나오면 자동으로 온라인으로 다시 빌드합니다.<br />
        exploded 폴더로 배포하면 JSP 수정은 저장만 해도 바로 반영됩니다. 접속 주소:
        <b>http://localhost:{{ cfg.httpPort }}{{ cfg.contextPath }}</b>
      </p>
    </div>

    <template #footer>
      <button class="btn" @click="store.dialog = null">취소</button>
      <button class="btn" @click="save(false)">저장</button>
      <button class="primary-btn" :disabled="!cfg.tomcatHome" @click="save(true)">저장 후 실행</button>
    </template>
  </Sheet>
</template>

<style scoped>
.actions {
  display: flex;
  gap: 6px;
}
.modes {
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
</style>
