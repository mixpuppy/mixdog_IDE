<script setup lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import { store, showPanel } from '../store'
import { ide } from '../ide'
import { run } from '../commands'
import { git, showGitView } from '../git'
import DogProgress from './DogProgress.vue'
import { tasks } from '../tasks'

const LABEL: Record<string, string> = {
  java: 'Java', kotlin: 'Kotlin', html: 'HTML', xml: 'XML', javascript: 'JavaScript',
  typescript: 'TypeScript', json: 'JSON', css: 'CSS', scss: 'SCSS', sql: 'SQL', yaml: 'YAML',
  ini: 'Properties', markdown: 'Markdown', plaintext: 'Plain Text'
}

const hasFile = computed(() => !!store.activePath)
const lang = computed(() => {
  const p = store.activePath ?? ''
  if (/\.jspf?$/i.test(p)) return 'JSP'
  if (/\.vue$/i.test(p)) return 'Vue'
  return LABEL[store.language] ?? store.language
})
const jdkLabel = computed(() => {
  const j = ide.info?.jdk
  return j ? `JDK ${j.major}` : 'JDK 없음'
})
const buildLabel = computed(() => {
  const t = ide.info?.build.tool
  return t === 'maven' ? 'Maven' : t === 'gradle' ? 'Gradle' : null
})
const tomcatText: Record<string, string> = { stopped: '', starting: 'Tomcat 시작 중…', running: 'Tomcat 실행 중' }
</script>

<template>
  <footer class="status">
    <div class="left">
      <span v-if="store.project" class="item" title="Git (Alt+9)" @click="showGitView">
        <Icon name="branch" :size="12" />
        <template v-if="git.status">
          {{ git.status.detached ? 'detached' : git.status.branch }}
          <span v-if="git.status.ahead">↑{{ git.status.ahead }}</span>
          <span v-if="git.status.behind">↓{{ git.status.behind }}</span>
          <span v-if="git.status.staged.length + git.status.unstaged.length" class="chg">● {{ git.status.staged.length + git.status.unstaged.length }}</span>
        </template>
        <template v-else>Git 없음</template>
      </span>
      <span class="item" @click="showPanel('problems')"><Icon name="warning" :size="12" /> 0</span>
      <span v-if="ide.tomcat !== 'stopped'" class="item" :class="ide.tomcat" @click="showPanel('tomcat')">
        <span class="dot" /> {{ tomcatText[ide.tomcat] }}
      </span>
    </div>
    <div class="right">
      <span v-if="tasks.list.length" class="item task" data-tasks-trigger :title="tasks.list.map((t) => t.title).join(', ')" @click="tasks.open = !tasks.open">
        <span class="t-title">{{ tasks.list[0].title }}</span>
        <DogProgress :pct="tasks.list[0].pct" :width="130" :height="5" />
        <span v-if="tasks.list.length > 1" class="more">+{{ tasks.list.length - 1 }}</span>
      </span>
      <template v-if="hasFile">
        <span class="item">{{ store.cursor.line }}:{{ store.cursor.col }}</span>
        <span class="item">{{ store.eol }}</span>
        <span class="item">UTF-8</span>
        <span class="item">{{ lang }}</span>
      </template>
      <template v-if="store.project && ide.info">
        <span v-if="buildLabel" class="item" title="빌드 도구" @click="run('settings.project')">{{ buildLabel }}</span>
        <span class="item jdk" :class="{ missing: !ide.info.jdk }" :title="ide.info.jdk?.home ?? ''" @click="run('settings.project')">
          {{ jdkLabel }}
        </span>
      </template>
    </div>
  </footer>
</template>

<style scoped>
.status {
  height: var(--statusbar-h);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  background: var(--chrome-strong);
  border-top: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 11.5px;
}
.left,
.right {
  display: flex;
  gap: 2px;
}
.item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 7px;
  height: 20px;
  border-radius: 4px;
}
.item:hover {
  background: var(--hover);
  color: var(--text);
}
.item.task {
  gap: 8px;
  margin-right: 6px;
  overflow: visible;
}
.t-title {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.more {
  font-weight: 700;
  font-size: 10.5px;
  padding: 0 5px;
  border-radius: 7px;
  background: var(--accent-soft);
  color: var(--accent);
}
.jdk {
  font-weight: 600;
  color: var(--text);
}
.jdk.missing {
  color: #ff9f0a;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ff9f0a;
}
.running .dot {
  background: var(--green);
}
</style>
