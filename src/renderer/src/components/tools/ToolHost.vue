<script setup lang="ts">
/**
 * Renders every tool window exactly once and teleports it into the dock it lives in.
 * Moving a tool only moves its DOM (Teleport target change) - nothing is remounted,
 * so the terminal keeps its shell and consoles keep their scroll position.
 */
import ProjectTool from './ProjectTool.vue'
import ServerTool from './ServerTool.vue'
import ConsoleTool from './ConsoleTool.vue'
import TerminalTool from './TerminalTool.vue'
import GitSidebar from '../git/GitSidebar.vue'
import EventLog from '../EventLog.vue'
import SearchTool from './SearchTool.vue'
import BuildToolWindow from './BuildToolWindow.vue'
import { layout, dockOf, dockGeneration, isToolVisible, type ToolId } from '../../layout'

const ids = Object.keys({ project: 1, search: 1, git: 1, server: 1, build: 1, tomcat: 1, events: 1, terminal: 1, problems: 1, buildtool: 1 }) as ToolId[]
void layout
</script>

<template>
  <Teleport v-for="id in ids" :key="`${id}:${dockGeneration()}`" defer :to="`#dock-${dockOf(id)}`">
    <div v-show="isToolVisible(id)" class="tool-pane" :data-tool="id">
      <ProjectTool v-if="id === 'project'" />
      <SearchTool v-else-if="id === 'search'" />
      <GitSidebar v-else-if="id === 'git'" />
      <ServerTool v-else-if="id === 'server'" />
      <BuildToolWindow v-else-if="id === 'buildtool'" />
      <ConsoleTool v-else-if="id === 'build'" which="build" />
      <ConsoleTool v-else-if="id === 'tomcat'" which="tomcat" />
      <div v-else-if="id === 'events'" class="pad"><EventLog /></div>
      <TerminalTool v-else-if="id === 'terminal'" />
      <div v-else-if="id === 'problems'" class="ph">문제 없음</div>
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
