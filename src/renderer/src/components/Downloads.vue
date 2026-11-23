<script setup lang="ts">
import { ide } from '../ide'
</script>

<template>
  <div v-for="(d, label) in ide.downloads" :key="label" class="dl">
    <div class="row">
      <span>{{ label }}</span>
      <span class="dim">{{ d.phase === 'extract' ? '압축 해제 중…' : d.pct >= 0 ? d.pct + '%' : '다운로드 중…' }}</span>
    </div>
    <div class="progress"><div :style="{ width: Math.max(0, d.pct) + '%' }" /></div>
  </div>
</template>

<style scoped>
.dl {
  margin: 8px 0;
}
.row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.dim {
  color: var(--text-dim);
}
</style>
