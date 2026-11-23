<script setup lang="ts">
/** Renders one node of the editor split tree (recursive): a pane, or panes side by side / stacked. */
import { ref } from 'vue'
import EditorPane from './EditorPane.vue'
import type { LayoutNode } from '../store'

defineOptions({ name: 'SplitNode' })
const props = defineProps<{ node: LayoutNode }>()
const box = ref<HTMLElement | null>(null)

/* drag the divider between children i-1 and i */
function startResize(e: MouseEvent, i: number): void {
  const n = props.node
  if (n.kind !== 'split' || !box.value) return
  const a = n.children[i - 1]
  const b = n.children[i]
  const rect = box.value.getBoundingClientRect()
  const row = n.dir === 'row'
  const total = n.children.reduce((s, c) => s + c.size, 0)
  const px = (row ? rect.width : rect.height) / total
  const start = row ? e.clientX : e.clientY
  const sa = a.size
  const sb = b.size
  const min = (sa + sb) * 0.12
  const move = (ev: MouseEvent): void => {
    const d = ((row ? ev.clientX : ev.clientY) - start) / px
    const na = Math.max(min, Math.min(sa + sb - min, sa + d))
    a.size = na
    b.size = sa + sb - na
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
  }
  document.body.style.cursor = row ? 'col-resize' : 'row-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
</script>

<template>
  <EditorPane v-if="node.kind === 'leaf'" :key="node.groupId" :group-id="node.groupId" />
  <div v-else ref="box" class="split" :class="node.dir">
    <template v-for="(c, i) in node.children" :key="c.kind === 'leaf' ? `g${c.groupId}` : `s${i}`">
      <div v-if="i > 0" class="divider" @mousedown.prevent="startResize($event, i)" />
      <div class="cell" :style="{ flex: `${c.size} 1 0` }">
        <SplitNode :node="c" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.split {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}
.split.row {
  flex-direction: row;
}
.split.column {
  flex-direction: column;
}
.cell {
  position: relative;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.divider {
  flex-shrink: 0;
  background: var(--border-strong);
  position: relative;
  z-index: 4;
}
.row > .divider {
  width: 1px;
  cursor: col-resize;
}
.column > .divider {
  height: 1px;
  cursor: row-resize;
}
.divider::after {
  content: '';
  position: absolute;
  inset: -3px;
}
.divider:hover {
  background: var(--accent);
}
</style>
