<script setup lang="ts">
/**
 * One editor pane (group). Drag a tab onto it: right edge = split right,
 * bottom edge = split down, middle = move the tab into this pane.
 */
import { ref, computed } from 'vue'
import EditorTabs from './EditorTabs.vue'
import CodeEditor from './CodeEditor.vue'
import Welcome from './Welcome.vue'
import { store, splitTab, splitToGroup, moveTab } from '../store'

const props = defineProps<{ groupId: number }>()
const group = computed(() => store.groups.find((g) => g.id === props.groupId))
const gi = (): number => store.groups.findIndex((g) => g.id === props.groupId)

const TAB_TYPE = 'application/x-mixdog-tab'
const zone = ref<'right' | 'bottom' | 'center' | null>(null)

function zoneAt(e: DragEvent, el: HTMLElement): 'right' | 'bottom' | 'center' {
  const r = el.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width
  const y = (e.clientY - r.top) / r.height
  if (x > 0.66 && x - 0.66 >= y - 0.66) return 'right'
  if (y > 0.66) return 'bottom'
  return 'center'
}

function dragOver(e: DragEvent): void {
  if (!e.dataTransfer?.types.includes(TAB_TYPE)) return
  e.preventDefault()
  zone.value = zoneAt(e, e.currentTarget as HTMLElement)
}

function drop(e: DragEvent): void {
  e.preventDefault()
  const raw = e.dataTransfer?.getData(TAB_TYPE)
  const z = zone.value ?? 'center'
  zone.value = null
  store.tabDrag = null
  if (!raw) return
  const { path, from } = JSON.parse(raw) as { path: string; from: number }
  const index = gi()
  if (z === 'center') moveTab(path, from, index)
  else if (from === index) splitTab(path, z === 'right' ? 'row' : 'column', index, true)
  else splitToGroup(path, z === 'right' ? 'row' : 'column', from, index)
}

const label = computed(() => {
  if (!zone.value) return ''
  if (zone.value === 'right') return '오른쪽으로 분할'
  if (zone.value === 'bottom') return '아래로 분할'
  return store.tabDrag && store.tabDrag.from !== gi() ? '이 창으로 옮기기' : ''
})
</script>

<template>
  <div
    v-if="group"
    class="pane"
    :class="{ focused: store.groups.length > 1 && gi() === store.activeGroup }"
    @mousedown.capture="store.activeGroup = gi()"
    @dragover="dragOver"
    @dragleave.self="zone = null"
    @drop="drop"
  >
    <EditorTabs v-if="group.tabs.length" :group-id="groupId" />
    <CodeEditor v-show="group.tabs.length" :group-id="groupId" />
    <Welcome v-if="!group.tabs.length" />
    <div v-if="store.tabDrag && zone" class="ghost" :class="zone">
      <span v-if="label">{{ label }}</span>
    </div>
  </div>
</template>

<style scoped>
.pane {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pane.focused::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  border-top: 2px solid var(--accent);
  pointer-events: none;
  z-index: 3;
  opacity: 0.7;
}
.ghost {
  position: absolute;
  z-index: 20;
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 2px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.ghost.center {
  inset: 40px 8px 8px;
}
.ghost.right {
  top: 8px;
  right: 8px;
  bottom: 8px;
  width: 48%;
}
.ghost.bottom {
  left: 8px;
  right: 8px;
  bottom: 8px;
  height: 48%;
}
.ghost span {
  padding: 4px 10px;
  border-radius: 7px;
  background: var(--elevated);
  box-shadow: var(--shadow);
  font-weight: 600;
  font-size: 12.5px;
}
</style>
