<script setup lang="ts">
/** Thin action row at the top of a tool window (title on the left, buttons on the right). */
defineProps<{ title?: string }>()
</script>

<template>
  <div class="tbar">
    <span v-if="title" class="section-label">{{ title }}</span>
    <div class="spacer" />
    <slot />
  </div>
</template>

<style scoped>
.tbar {
  height: 30px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px 0 12px;
}
.spacer {
  flex: 1;
}
.tbar :deep(.icon-btn) {
  width: 24px;
  height: 24px;
}
.tbar :deep(.link) {
  color: var(--accent);
  font-size: 12px;
  margin-right: 6px;
  cursor: pointer;
}
</style>
