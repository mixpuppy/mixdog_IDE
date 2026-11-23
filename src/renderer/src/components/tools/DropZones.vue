<script setup lang="ts">
/** Big drop targets (left / right / bottom) shown while a tool window is being dragged. */
import { ref } from 'vue'
import { layout, moveTool, TOOLS, toolTitle, DND_TYPE, type DockId, type ToolId } from '../../layout'

const over = ref<DockId | null>(null)
const ZONES: { id: DockId; label: string }[] = [
  { id: 'left', label: '왼쪽' },
  { id: 'bottom', label: '아래' },
  { id: 'right', label: '오른쪽' }
]

function dragOver(e: DragEvent, d: DockId): void {
  if (!e.dataTransfer?.types.includes(DND_TYPE)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  over.value = d
}
function drop(e: DragEvent, d: DockId): void {
  e.preventDefault()
  const id = e.dataTransfer?.getData(DND_TYPE) as ToolId
  if (id) moveTool(id, d)
  over.value = null
  layout.dragging = null
}
</script>

<template>
  <div class="zones">
    <div
      v-for="z in ZONES"
      :key="z.id"
      class="zone"
      :class="[z.id, { over: over === z.id }]"
      @dragover="dragOver($event, z.id)"
      @dragleave="over = over === z.id ? null : over"
      @drop="drop($event, z.id)"
    >
      <span class="label">{{ layout.dragging ? toolTitle(layout.dragging) : '' }} → {{ z.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.zones {
  position: absolute;
  inset: 0;
  z-index: 60;
  pointer-events: none;
}
.zone {
  position: absolute;
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  border: 2px dashed color-mix(in srgb, var(--accent) 55%, transparent);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  transition: background 0.12s, border-color 0.12s;
}
.zone.left {
  left: calc(var(--activity-w) + 8px);
  top: 8px;
  bottom: 8px;
  width: 22%;
}
.zone.right {
  right: calc(var(--activity-w) + 8px);
  top: 8px;
  bottom: 8px;
  width: 22%;
}
.zone.bottom {
  left: calc(22% + var(--activity-w) + 16px);
  right: calc(22% + var(--activity-w) + 16px);
  bottom: 8px;
  height: 34%;
}
.zone.over {
  border-color: var(--accent);
  border-style: solid;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
.label {
  padding: 5px 12px;
  border-radius: 8px;
  background: var(--elevated);
  box-shadow: var(--shadow);
  font-size: 12.5px;
  font-weight: 600;
  pointer-events: none;
}
</style>
