<script setup lang="ts">
/** Build or Tomcat console with its actions. */
import Icon from '../Icon.vue'
import ConsoleView from '../ConsoleView.vue'
import ToolBar from './ToolBar.vue'
import { ide } from '../../ide'
import { run } from '../../commands'

defineProps<{ which: 'build' | 'tomcat' }>()
</script>

<template>
  <div class="tool">
    <ToolBar>
      <template v-if="which === 'build'">
        <button v-if="ide.building" class="icon-btn" title="빌드 중지" @click="run('build.stop')"><Icon name="stop" :size="11" /></button>
        <button v-else class="icon-btn" title="빌드 (Ctrl+F9)" @click="run('build.run')"><Icon name="hammer" :size="14" /></button>
        <button class="icon-btn" title="지우기" @click="ide.buildOut.clear()"><Icon name="trash" :size="13" /></button>
      </template>
      <template v-else>
        <button v-if="ide.tomcat === 'running'" class="link" @click="run('run.openBrowser')">{{ ide.appUrl }} ↗</button>
        <button class="icon-btn" title="지우기" @click="ide.tomcatOut.clear()"><Icon name="trash" :size="13" /></button>
      </template>
    </ToolBar>
    <div class="body">
      <ConsoleView v-if="which === 'build'" :buf="ide.buildOut" empty="Ctrl+F9 로 빌드하면 출력이 여기 나옵니다." />
      <ConsoleView v-else :buf="ide.tomcatOut" empty="Shift+F10 으로 Tomcat 을 실행하면 로그가 여기 나옵니다." />
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
.body {
  flex: 1;
  min-height: 0;
  padding: 0 14px 8px;
}
</style>
