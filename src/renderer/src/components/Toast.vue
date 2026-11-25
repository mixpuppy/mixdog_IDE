<script setup lang="ts">
import { ide } from '../ide'
import { showError } from '../ui'

function click(): void {
  const t = ide.toast
  ide.toast = null
  if (t?.full) showError({ title: t.kind === 'error' ? '오류' : '알림', summary: t.text, raw: t.full })
}
</script>

<template>
  <Transition name="toast">
    <div v-if="ide.toast" class="toast" :class="ide.toast.kind" :title="ide.toast.full ? '클릭하면 전체 내용' : '클릭하면 닫기'" @click="click">
      {{ ide.toast.text }}
      <span v-if="ide.toast.full" class="more">자세히 보기 ›</span>
    </div>
  </Transition>
</template>

<style scoped>
.toast {
  position: fixed;
  right: 18px;
  bottom: calc(var(--statusbar-h) + 14px);
  max-width: 460px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--elevated);
  box-shadow: var(--shadow);
  border-left: 3px solid var(--accent);
  z-index: 200;
  user-select: text;
  line-height: 1.5;
}
.more {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--accent);
  cursor: pointer;
}
.toast.ok {
  border-left-color: var(--green);
}
.toast.error {
  border-left-color: var(--red);
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
