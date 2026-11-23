<script setup lang="ts">
/**
 * Tool window stripe (IntelliJ style). The left stripe lists left-side windows at the top and
 * bottom-panel windows at the bottom; the right stripe lists right-side windows.
 * Click = show / hide. Drag an icon up/down to reorder, or onto another group / stripe to move it.
 */
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import { store, setEditorHidden } from '../store'
import { layout, TOOLS, toolTitle, toggleTool, isToolVisible, moveTool, onToolDragStart, onToolDragEnd, DND_TYPE, type DockId, type ToolId } from '../layout'

const props = withDefaults(defineProps<{ side?: 'left' | 'right' }>(), { side: 'left' })

const groups = computed<{ dock: DockId; tools: ToolId[] }[]>(() =>
  props.side === 'left'
    ? [
        { dock: 'left', tools: layout.docks.left },
        { dock: 'bottom', tools: layout.docks.bottom }
      ]
    : [{ dock: 'right', tools: layout.docks.right }]
)

/** where the dragged icon would land: group + insert index */
const marker = ref<{ dock: DockId; index: number } | null>(null)

function click(id: ToolId): void {
  const wasVisible = isToolVisible(id)
  toggleTool(id)
  // Git also opens the commit graph in the main area; the project tree brings the editor back
  if (id === 'git' && !wasVisible) {
    store.mainView = 'git'
    if (store.editorHidden) setEditorHidden(false)
  } else if (id === 'project' && !wasVisible) store.mainView = 'editor'
}

function overIcon(e: DragEvent, dock: DockId, index: number): void {
  if (!e.dataTransfer?.types.includes(DND_TYPE)) return
  e.preventDefault()
  e.stopPropagation()
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  marker.value = { dock, index: e.clientY > r.top + r.height / 2 ? index + 1 : index }
}

function overGroup(e: DragEvent, dock: DockId): void {
  if (!e.dataTransfer?.types.includes(DND_TYPE)) return
  e.preventDefault()
  // empty space in the group: append at its end
  if (e.target === e.currentTarget) marker.value = { dock, index: layout.docks[dock].length }
}

function drop(e: DragEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const id = e.dataTransfer?.getData(DND_TYPE) as ToolId
  if (id && marker.value) moveTool(id, marker.value.dock, marker.value.index)
  marker.value = null
  layout.dragging = null
}

function leave(e: DragEvent): void {
  if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) marker.value = null
}
</script>

<template>
  <nav class="activity" :class="side" @dragleave="leave">
    <template v-for="(g, gi) in groups" :key="g.dock">
      <div v-if="gi > 0" class="spacer" />
      <div
        class="grp"
        :class="{ over: marker?.dock === g.dock, empty: !g.tools.length }"
        :title="g.tools.length ? '' : g.dock === 'right' ? '여기에 놓으면 오른쪽 창' : g.dock === 'bottom' ? '여기에 놓으면 아래 창' : '여기에 놓으면 왼쪽 창'"
        @dragover="overGroup($event, g.dock)"
        @drop="drop"
      >
        <template v-for="(id, i) in g.tools" :key="id">
          <div v-if="marker?.dock === g.dock && marker.index === i" class="mark" />
          <button
            class="act"
            :class="{ on: isToolVisible(id), dragging: layout.dragging === id }"
            :title="`${toolTitle(id)}${TOOLS[id].hint ? ` (${TOOLS[id].hint})` : ''} · 끌어서 순서 바꾸기 / 다른 쪽으로 옮기기`"
            draggable="true"
            @click="click(id)"
            @dragstart="onToolDragStart($event, id)"
            @dragend="onToolDragEnd(); marker = null"
            @dragover="overIcon($event, g.dock, i)"
            @drop="drop"
          >
            <Icon :name="TOOLS[id].icon" :size="18" />
          </button>
        </template>
        <div v-if="marker?.dock === g.dock && marker.index === g.tools.length" class="mark" />
      </div>
    </template>
  </nav>
</template>

<style scoped>
.activity {
  width: var(--activity-w);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  background: var(--chrome);
  /* above the big drop zones, so icons stay precise drop targets */
  position: relative;
  z-index: 70;
}
.activity.left {
  border-right: 1px solid var(--border);
}
.activity.right {
  border-left: 1px solid var(--border);
}
.grp {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 40px;
  padding: 3px 0;
  border-radius: 9px;
}
.grp.empty {
  min-height: 40px;
}
.grp.over {
  background: var(--accent-soft);
}
.mark {
  width: 28px;
  height: 3px;
  margin: -3.5px 0;
  border-radius: 2px;
  background: var(--accent);
  position: relative;
  z-index: 1;
}
.act {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  transition: background 0.12s, color 0.12s;
}
.act:hover {
  background: var(--hover);
  color: var(--text);
}
.act.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.act.dragging {
  opacity: 0.35;
}
.spacer {
  flex: 1;
}
</style>
