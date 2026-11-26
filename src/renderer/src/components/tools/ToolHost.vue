<script setup lang="ts">
/**
 * Renders every tool window once and teleports it into the dock it lives in.
 * A tool is created the first time it is shown (its code is loaded only then), and
 * after that kept alive: moving it only moves its DOM (Teleport target change), so the
 * terminal keeps its shell and consoles keep their scroll position.
 */
import { defineAsyncComponent, reactive, watchEffect } from 'vue'
import ProjectTool from './ProjectTool.vue'
import { layout, dockOf, dockGeneration, isToolVisible, type ToolId } from '../../layout'

const ServerTool = defineAsyncComponent(() => import('./ServerTool.vue'))
const ConsoleTool = defineAsyncComponent(() => import('./ConsoleTool.vue'))
const TerminalTool = defineAsyncComponent(() => import('./TerminalTool.vue'))
const GitSidebar = defineAsyncComponent(() => import('../git/GitSidebar.vue'))
const EventLog = defineAsyncComponent(() => import('../EventLog.vue'))
const SearchTool = defineAsyncComponent(() => import('./SearchTool.vue'))
const BuildToolWindow = defineAsyncComponent(() => import('./BuildToolWindow.vue'))
const DatabaseTool = defineAsyncComponent(() => import('../db/DatabaseTool.vue'))
const ProblemsTool = defineAsyncComponent(() => import('./ProblemsTool.vue'))
const DebugTool = defineAsyncComponent(() => import('./DebugTool.vue'))
const MrTool = defineAsyncComponent(() => import('../git/MrTool.vue'))

const ids = Object.keys({ project: 1, search: 1, git: 1, server: 1, build: 1, tomcat: 1, events: 1, terminal: 1, problems: 1, buildtool: 1, database: 1, debug: 1, mr: 1 }) as ToolId[]
void layout

/** tools that have been shown at least once (never unmounted afterwards) */
const mounted = reactive<Partial<Record<ToolId, boolean>>>({})
watchEffect(() => {
  for (const id of ids) if (!mounted[id] && isToolVisible(id)) mounted[id] = true
})
</script>

<template>
  <Teleport v-for="id in ids" :key="`${id}:${dockGeneration()}`" defer :to="`#dock-${dockOf(id)}`">
    <div v-if="mounted[id]" v-show="isToolVisible(id)" class="tool-pane" :data-tool="id">
      <ProjectTool v-if="id === 'project'" />
      <SearchTool v-else-if="id === 'search'" />
      <GitSidebar v-else-if="id === 'git'" />
      <ServerTool v-else-if="id === 'server'" />
      <BuildToolWindow v-else-if="id === 'buildtool'" />
      <DatabaseTool v-else-if="id === 'database'" />
      <ConsoleTool v-else-if="id === 'build'" which="build" />
      <ConsoleTool v-else-if="id === 'tomcat'" which="tomcat" />
      <div v-else-if="id === 'events'" class="pad"><EventLog /></div>
      <TerminalTool v-else-if="id === 'terminal'" />
      <ProblemsTool v-else-if="id === 'problems'" />
      <DebugTool v-else-if="id === 'debug'" />
      <MrTool v-else-if="id === 'mr'" />
    </div>
  </Teleport>
</template>

<style scoped>
.tool-pane {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.tool-pane > * {
  flex: 1;
  min-height: 0;
}
.pad {
  padding: 4px 14px 8px;
}
.ph {
  padding: 8px 16px;
  color: var(--text-dim);
  line-height: 1.8;
}
.ph ul {
  padding-left: 18px;
  margin: 4px 0;
}
</style>
