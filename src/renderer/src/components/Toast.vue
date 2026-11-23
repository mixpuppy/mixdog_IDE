<script setup lang="ts">
import { ide } from '../ide'
</script>

<template>
  <Transition name="toast">
    <div v-if="ide.toast" class="toast" :class="ide.toast.kind" @click="ide.toast = null">
      {{ ide.toast.text }}
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
