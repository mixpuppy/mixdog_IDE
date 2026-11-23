<script setup lang="ts">
/**
 * One tool window dock (left / right / bottom). Like IntelliJ it shows one tool window at a
 * time with just that window's title; tool windows are switched and reordered from the
 * side icon bars. Drag the title to move the window to another side.
 */
import { computed, onMounted } from 'vue'
import Icon from '../Icon.vue'
import { layout, TOOLS, toolTitle, dockMounted, hideDock, onToolDragStart, onToolDragEnd, type DockId } from '../../layout'

const props = defineProps<{ pos: DockId }>()
const active = computed(() => layout.active[props.pos])
// a new body element (first render, hot reload) makes ToolHost teleport the tools into it again
onMounted(() => dockMounted(props.pos))

function startResize(e: MouseEvent): void {
  const start = props.pos === 'bottom' ? e.clientY : e.clientX
  const startSize = layout.size[props.pos]
  const max = props.pos === 'bottom' ? window.innerHeight * 0.75 : window.innerWidth * 0.5
  const move = (ev: MouseEvent): void => {
    const cur = props.pos === 'bottom' ? ev.clientY : ev.clientX
    const d = props.pos === 'left' ? cur - start : start - cur
    layout.size[props.pos] = Math.round(Math.min(max, Math.max(props.pos === 'bottom' ? 100 : 180, startSize + d)))
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
  }
  document.body.style.cursor = props.pos === 'bottom' ? 'row-resize' : 'col-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
</script>

<template>
  <section
    class="dock"
    :class="pos"
    :style="pos === 'bottom' ? { height: layout.size.bottom + 'px' } : { width: layout.size[pos] + 'px' }"
  >
    <div class="resizer" @mousedown.prevent="startResize" />
    <div class="bar">
      <div
        v-if="active"
        class="title"
        draggable="true"
        :title="`${toolTitle(active)}${TOOLS[active].hint ? ` (${TOOLS[active].hint})` : ''} · 드래그해서 다른 쪽으로 옮기기`"
        @dragstart="onToolDragStart($event, active)"
        @dragend="onToolDragEnd"
      >
        <Icon :name="TOOLS[active].icon" :size="13" />
        <span>{{ toolTitle(active) }}</span>
      </div>
      <div class="spacer" />
      <button class="icon-btn hide" title="숨기기" @click="hideDock(pos)">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
      </button>
    </div>
    <div :id="`dock-${pos}`" class="body" />
  </section>
</template>

<style scoped>
.dock {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.dock.left {
  background: var(--chrome);
  border-right: 1px solid var(--border);
}
.dock.right {
  background: var(--chrome);
  border-left: 1px solid var(--border);
}
.dock.bottom {
  background: var(--surface);
  border-top: 1px solid var(--border);
}
.resizer {
  position: absolute;
  z-index: 6;
}
.left .resizer {
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
}
.right .resizer {
  top: 0;
  left: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
}
.bottom .resizer {
  top: -3px;
  left: 0;
  right: 0;
  height: 6px;
  cursor: row-resize;
}
.bar {
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 6px 0 8px;
}
.title {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
  cursor: grab;
}
.title:hover {
  background: var(--hover);
}
.spacer {
  flex: 1;
}
.icon-btn.hide {
  width: 22px;
  height: 22px;
}
.body {
  position: relative;
  flex: 1;
  min-height: 0;
}
</style>
