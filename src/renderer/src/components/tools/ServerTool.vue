<script setup lang="ts">
import { ide } from '../../ide'
import { store } from '../../store'
import { run } from '../../commands'

const STATE: Record<string, string> = { stopped: '중지됨', starting: '시작 중…', running: '실행 중' }
</script>

<template>
  <div v-if="!store.project" class="empty"><p>프로젝트를 먼저 여세요</p></div>
  <div v-else class="server">
    <div class="srv-card">
      <div class="srv-title">
        <span class="dot" :class="ide.tomcat" />
        <b>{{ ide.info?.tomcat ? `Tomcat ${ide.info.tomcat.version}` : 'Tomcat 미설정' }}</b>
        <span class="srv-state">{{ STATE[ide.tomcat] }}</span>
      </div>
      <div v-if="ide.info" class="srv-meta">
        <div>JDK {{ ide.info.jdk?.major ?? '없음' }} · {{ ide.info.build.tool ?? '빌드 도구 없음' }}</div>
        <div>http://localhost:{{ ide.info.settings.run.httpPort }}{{ ide.info.settings.run.contextPath }}</div>
      </div>
      <div class="srv-actions">
        <button v-if="ide.tomcat === 'stopped'" class="primary-btn" :disabled="ide.building" @click="run(ide.info?.settings.run.tomcatHome ? 'run.start' : 'settings.run')">▶ 실행</button>
        <button v-else class="btn" @click="run('run.stop')">■ 중지</button>
        <button v-if="ide.tomcat === 'running'" class="btn" @click="run('run.openBrowser')">브라우저</button>
        <button class="btn" @click="run('settings.run')">구성…</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.empty {
  padding: 20px 14px;
  color: var(--text-dim);
}
.server {
  padding: 8px 12px;
}
.srv-card {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
}
.srv-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.srv-state {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 12px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint);
}
.dot.starting {
  background: #ff9f0a;
}
.dot.running {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
}
.srv-meta {
  margin: 8px 0 12px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.7;
  word-break: break-all;
}
.srv-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
