<script setup lang="ts">
/** macOS-style sheet: drops down from under the title bar over a dimmed window. */
import { onMounted, onBeforeUnmount } from 'vue'

withDefaults(defineProps<{ title: string; width?: number }>(), { width: 640 })
const emit = defineEmits<{ close: [] }>()

const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="backdrop" @mousedown.self="emit('close')">
    <div class="sheet" :style="{ width: width + 'px' }">
      <div class="head">{{ title }}</div>
      <div class="content"><slot /></div>
      <div class="foot"><slot name="footer" /></div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: var(--titlebar-h) 0 0 0;
  background: rgba(0, 0, 0, 0.28);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  z-index: 100;
  animation: fade 0.15s ease-out;
}
.sheet {
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - var(--titlebar-h) - 40px);
  display: flex;
  flex-direction: column;
  background: var(--elevated);
  border-radius: 0 0 12px 12px;
  box-shadow: var(--shadow);
  animation: drop 0.2s cubic-bezier(0.2, 0.9, 0.3, 1);
  overflow: hidden;
}
.head {
  padding: 16px 20px 6px;
  font-size: 14px;
  font-weight: 700;
}
.content {
  padding: 6px 20px 14px;
  overflow: auto;
  user-select: text;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
}
@keyframes drop {
  from {
    transform: translateY(-24px);
    opacity: 0;
  }
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
</style>
