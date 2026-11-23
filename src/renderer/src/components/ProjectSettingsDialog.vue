<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import Sheet from './Sheet.vue'
import Downloads from './Downloads.vue'
import { store } from '../store'
import { ide, loadProjectInfo, saveSettings, toast } from '../ide'
import type { JdkInfo } from '../types'

const jdks = ref<JdkInfo[]>([])
const jdkHome = ref<string | null>(ide.info?.settings.jdkHome ?? null)
const goals = ref(ide.info?.settings.buildGoals ?? '')
const menu = ref(false)
const busy = ref(false)

const build = computed(() => ide.info?.build)
const VIA: Record<string, string> = {
  wrapper: '프로젝트 래퍼',
  managed: 'IDE 관리',
  path: '시스템 PATH',
  missing: '찾을 수 없음',
  none: ''
}

async function refresh(): Promise<void> {
  jdks.value = (await window.api.jdk.list()) as unknown as JdkInfo[]
}
onMounted(refresh)

function source(j: JdkInfo): string {
  if (j.managed) return 'IDE 관리'
  if (j.home.includes('.jdks')) return 'IntelliJ'
  return ''
}

async function download(major: number): Promise<void> {
  menu.value = false
  busy.value = true
  try {
    const j = (await window.api.jdk.download(major)) as unknown as JdkInfo | null
    await refresh()
    if (j) jdkHome.value = j.home
  } catch {
    /* toast via event */
  } finally {
    busy.value = false
  }
}

async function addFolder(): Promise<void> {
  try {
    const j = (await window.api.jdk.add()) as unknown as JdkInfo | null
    await refresh()
    if (j) jdkHome.value = j.home
  } catch {
    /* toast via event */
  }
}

async function downloadMaven(): Promise<void> {
  busy.value = true
  try {
    await window.api.maven.download()
    await loadProjectInfo()
  } catch {
    /* toast via event */
  } finally {
    busy.value = false
  }
}

async function save(): Promise<void> {
  if (!ide.info) return
  ide.info.settings.jdkHome = jdkHome.value
  ide.info.settings.buildGoals = goals.value.trim() || null
  await saveSettings()
  toast('프로젝트 설정을 저장했습니다', 'ok')
  store.dialog = null
}
</script>

<template>
  <Sheet title="프로젝트 설정" :width="660" @close="store.dialog = null">
    <div class="group">
      <div class="group-title">
        <span>
          프로젝트 JDK
          <span v-if="ide.info?.detectedJava" class="tag accent">빌드 파일 기준 Java {{ ide.info.detectedJava }}</span>
        </span>
        <span class="actions">
          <button class="btn small" @click="addFolder">폴더 추가…</button>
          <span class="menu-wrap">
            <button class="btn small" :disabled="busy" @click="menu = !menu">JDK 다운로드 ▾</button>
            <div v-if="menu" class="menu">
              <button @click="download(25)">Temurin 25 (최신 LTS)</button>
              <button @click="download(21)">Temurin 21 (LTS)</button>
              <button @click="download(17)">Temurin 17 (LTS)</button>
              <button @click="download(11)">Temurin 11 (LTS)</button>
              <button @click="download(8)">Temurin 8 (LTS)</button>
            </div>
          </span>
        </span>
      </div>
      <div class="group-box">
        <div
          v-for="j in jdks"
          :key="j.home"
          class="opt-row selectable"
          :class="{ on: j.home === jdkHome }"
          @click="jdkHome = j.home"
        >
          <span class="radio" />
          <div class="opt-main">
            <div class="opt-title">
              JDK {{ j.major }}
              <span class="ver">{{ j.version }}</span>
              <span v-if="j.vendor" class="tag">{{ j.vendor }}</span>
              <span v-if="source(j)" class="tag accent">{{ source(j) }}</span>
              <span v-if="ide.info?.detectedJava && j.major < ide.info.detectedJava" class="tag warn">버전 낮음</span>
            </div>
            <div class="opt-sub">{{ j.home }}</div>
          </div>
        </div>
        <div v-if="!jdks.length" class="opt-row">설치된 JDK 가 없습니다. 다운로드하세요.</div>
      </div>
      <Downloads />
      <p class="hint">JDK 는 이 프로젝트의 빌드와 Tomcat 실행에만 쓰이고, 시스템 JAVA_HOME 은 바뀌지 않습니다.</p>
    </div>

    <div class="group">
      <div class="group-title"><span>빌드 도구</span></div>
      <div class="group-box">
        <div class="field">
          <label>도구</label>
          <div>
            <b>{{ build?.tool === 'maven' ? 'Maven' : build?.tool === 'gradle' ? 'Gradle' : '없음' }}</b>
            <span v-if="build?.tool" class="tag" :class="{ warn: build.via === 'missing' }" style="margin-left: 6px">
              {{ VIA[build.via] }}
            </span>
            <button
              v-if="build?.tool === 'maven' && build.via !== 'wrapper'"
              class="btn small"
              style="margin-left: 8px"
              :disabled="busy"
              @click="downloadMaven"
            >
              {{ build.via === 'missing' ? 'Maven 다운로드' : '최신 Maven 받기' }}
            </button>
          </div>
        </div>
        <div v-if="build?.exe" class="field">
          <label>실행 파일</label>
          <span class="opt-sub">{{ build.exe }}</span>
        </div>
        <div v-if="build?.tool" class="field">
          <label>빌드 명령</label>
          <input v-model="goals" class="input mono" :placeholder="build.defaultGoals" spellcheck="false" />
        </div>
      </div>
      <p v-if="!build?.tool" class="hint">pom.xml 또는 build.gradle 이 프로젝트 최상위에 있으면 자동으로 인식합니다.</p>
    </div>

    <template #footer>
      <button class="btn" @click="store.dialog = null">취소</button>
      <button class="primary-btn" @click="save">저장</button>
    </template>
  </Sheet>
</template>

<style scoped>
.actions {
  display: flex;
  gap: 6px;
}
.ver {
  font-weight: 400;
  color: var(--text-dim);
  font-size: 12px;
}
</style>
