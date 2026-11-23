<script setup lang="ts">
/** Variables of the selected frame; objects / arrays expand lazily. */
import Icon from '../Icon.vue'
import { expand, type VarNode } from '../../debug'

defineProps<{ nodes: VarNode[]; depth: number }>()

const isStr = (n: VarNode): boolean => n.type === 'String' && n.value !== 'null'

function copy(n: VarNode): void {
  void navigator.clipboard.writeText(n.value.replace(/^"(.*)"$/s, '$1'))
}
</script>

<template>
  <template v-for="(n, i) in nodes" :key="i">
    <div class="vrow" :style="{ paddingLeft: 8 + depth * 16 + 'px' }" :title="`${n.type} ${n.name} = ${n.value}`" @click="expand(n)" @dblclick.stop="copy(n)">
      <span class="chev">
        <Icon v-if="n.ref" :name="n.open ? 'chevronDown' : 'chevronRight'" :size="11" />
      </span>
      <span class="name">{{ n.name }}</span>
      <span class="eq">=</span>
      <span class="val" :class="{ str: isStr(n), nul: n.value === 'null' }">{{ n.value }}</span>
      <span v-if="n.type" class="type">{{ n.type }}</span>
      <span v-if="n.loading" class="spin" />
    </div>
    <VarTree v-if="n.open && n.children" :nodes="n.children" :depth="depth + 1" />
  </template>
</template>

<style scoped>
.vrow {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 23px;
  padding-right: 10px;
  white-space: nowrap;
  font-family: var(--font-code);
  font-size: 12px;
  cursor: default;
}
.vrow:hover {
  background: var(--hover);
}
.chev {
  width: 12px;
  flex-shrink: 0;
  display: inline-flex;
  color: var(--text-dim);
}
.name {
  color: #c77dff;
}
.eq {
  color: var(--text-faint);
}
.val {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.val.str {
  color: var(--green);
}
.val.nul {
  color: var(--text-faint);
}
.type {
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 11px;
}
.spin {
  width: 9px;
  height: 9px;
  border: 1.5px solid var(--text-faint);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
