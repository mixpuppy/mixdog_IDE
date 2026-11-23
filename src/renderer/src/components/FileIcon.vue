<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ name: string }>()

/** Extension -> [label, color]. Tweak freely. */
const MAP: Record<string, [string, string]> = {
  java: ['J', '#f0883e'],
  kt: ['K', '#a97bff'],
  jsp: ['JSP', '#e44d26'],
  jspf: ['JSP', '#e44d26'],
  vue: ['V', '#41b883'],
  js: ['JS', '#e8c547'],
  mjs: ['JS', '#e8c547'],
  ts: ['TS', '#3b82f6'],
  html: ['<>', '#e44d26'],
  xml: ['<>', '#8e8e93'],
  css: ['#', '#3b9fd9'],
  scss: ['#', '#cf649a'],
  json: ['{}', '#d0a72f'],
  properties: ['≡', '#8e8e93'],
  yml: ['≡', '#cb4b4b'],
  yaml: ['≡', '#cb4b4b'],
  sql: ['DB', '#5e9ee0'],
  md: ['M', '#6e8bd8'],
  gradle: ['G', '#5fa58a'],
  bat: ['>', '#8e8e93'],
  sh: ['>', '#8e8e93']
}

const info = computed(() => {
  const ext = props.name.split('.').pop()?.toLowerCase() ?? ''
  if (props.name === 'pom.xml') return ['m', '#c75b5b']
  return MAP[ext] ?? ['', 'var(--text-faint)']
})
</script>

<template>
  <span class="fi" :style="{ color: info[1] }">
    <template v-if="info[0]">{{ info[0] }}</template>
    <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M4.5 2.5h4.6l2.9 2.9v7.6a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5zM9 2.6V5.5h2.9" />
    </svg>
  </span>
</template>

<style scoped>
.fi {
  width: 18px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-code);
  font-size: 8.5px;
  font-weight: 800;
  letter-spacing: -0.03em;
}
</style>
