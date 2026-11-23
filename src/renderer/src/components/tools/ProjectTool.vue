<script setup lang="ts">
import { ref, watch } from 'vue'
import Icon from '../Icon.vue'
import TreeNode from '../TreeNode.vue'
import ToolBar from './ToolBar.vue'
import { store, openFolder } from '../../store'
import { tree, revealInTree, setAutoFollow, collapseAll } from '../../tree'

const roots = ref<{ name: string; path: string; isDir: boolean }[]>([])
const treeKey = ref(0)

async function loadRoot(): Promise<void> {
  roots.value = store.project ? await window.api.fs.readDir(store.project.path) : []
  treeKey.value++
}
watch(() => store.project?.path, loadRoot, { immediate: true })
</script>

<template>
  <div class="tool">
    <ToolBar>
      <button class="icon-btn" :disabled="!store.activePath" title="열린 파일 위치 찾기" @click="revealInTree()"><Icon name="target" :size="14" /></button>
      <button
        class="icon-btn"
        :class="{ on: tree.autoFollow }"
        :title="tree.autoFollow ? '열린 파일 자동 선택: 켜짐 (탭을 바꾸면 트리가 따라감)' : '열린 파일 자동 선택: 꺼짐'"
        @click="setAutoFollow(!tree.autoFollow)"
      >
        <Icon name="follow" :size="14" />
      </button>
      <button class="icon-btn" title="모두 접기" @click="collapseAll"><Icon name="collapseAll" :size="14" /></button>
      <button class="icon-btn" title="새로고침" @click="loadRoot"><Icon name="refresh" :size="14" /></button>
      <button class="icon-btn" title="폴더 열기" @click="openFolder"><Icon name="open" :size="14" /></button>
    </ToolBar>
    <div v-if="store.project" :key="treeKey" class="tree">
      <div class="root-label">
        <Icon name="folder" :size="15" class="folder" />
        <b>{{ store.project.name }}</b>
        <span class="path">{{ store.project.path }}</span>
      </div>
      <TreeNode v-for="e in roots" :key="e.path" :entry="e" :depth="0" />
    </div>
    <div v-else class="empty">
      <p>열린 프로젝트가 없습니다</p>
      <button class="primary-btn" @click="openFolder">폴더 열기</button>
    </div>
  </div>
</template>

<style scoped>
.tool {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.icon-btn.on {
  color: var(--accent);
  background: var(--accent-soft);
}
.icon-btn:disabled {
  opacity: 0.35;
}
.tree {
  flex: 1;
  overflow: auto;
  padding-bottom: 12px;
}
.root-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 14px 6px;
  white-space: nowrap;
  overflow: hidden;
}
.root-label .path {
  color: var(--text-faint);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.folder {
  color: #5ea8f2;
  flex-shrink: 0;
}
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-dim);
}
</style>
