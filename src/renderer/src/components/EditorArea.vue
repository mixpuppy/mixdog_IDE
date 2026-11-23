<script setup lang="ts">
/** Editor area: the split tree of editor panes (see SplitNode / EditorPane). */
import SplitNode from './SplitNode.vue'
import { store } from '../store'
</script>

<template>
  <div class="area">
    <SplitNode :node="store.editorLayout" />
  </div>
</template>

<style scoped>
.area {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
}
</style>
