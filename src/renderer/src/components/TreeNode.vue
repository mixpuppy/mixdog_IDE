<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import Icon from './Icon.vue'
import FileIcon from './FileIcon.vue'
import { store, openFile } from '../store'
import { tree, isExpanded, setExpanded, samePath, normPath } from '../tree'

interface Entry {
  name: string
  path: string
  isDir: boolean
}

const props = defineProps<{ entry: Entry; depth: number }>()

const row = ref<HTMLElement | null>(null)
const children = ref<Entry[] | null>(null)
const loading = ref(false)
const open = computed(() => props.entry.isDir && isExpanded(props.entry.path))

/** Build/tooling folders shown dimmed, like IntelliJ's "excluded" folders. */
const DIMMED = new Set(['node_modules', 'target', 'build', 'out', 'dist', '.git', '.idea', '.gradle', '.vscode', 'bin'])
const dimmed = computed(() => DIMMED.has(props.entry.name))
const selected = computed(() => samePath(store.selectedPath, props.entry.path))
/** the file shown in the focused editor */
const active = computed(() => !props.entry.isDir && samePath(store.activePath, props.entry.path))
/** folder that contains the active file (subtle hint while collapsed) */
const holdsActive = computed(() => {
  if (!props.entry.isDir || open.value || !store.activePath) return false
  return normPath(store.activePath).startsWith(normPath(props.entry.path) + '\\')
})

async function load(): Promise<void> {
  if (children.value !== null || loading.value) return
  loading.value = true
  try {
    children.value = await window.api.fs.readDir(props.entry.path)
  } catch {
    children.value = []
  } finally {
    loading.value = false
  }
}
// expanded from anywhere (click, or revealing the active file): load the folder
watch(open, (o) => o && load(), { immediate: true })

// scroll to this row when it is the file being revealed
watch(
  () => tree.reveal === normPath(props.entry.path),
  async (hit) => {
    if (!hit) return
    await nextTick()
    row.value?.scrollIntoView({ block: 'nearest' })
    tree.reveal = null
  },
  { immediate: true }
)

function toggle(): void {
  store.selectedPath = props.entry.path
  if (!props.entry.isDir) {
    openFile(props.entry.path)
    return
  }
  setExpanded(props.entry.path, !open.value)
}
</script>

<template>
  <div
    ref="row"
    class="row"
    :class="{ selected, active, holds: holdsActive, focused: store.windowFocused, dimmed }"
    :style="{ paddingLeft: 8 + depth * 14 + 'px' }"
    :title="active ? `${entry.path} (지금 에디터에 열린 파일)` : entry.path"
    @click="toggle"
  >
    <span class="chev">
      <Icon v-if="entry.isDir" :name="open ? 'chevronDown' : 'chevronRight'" :size="11" />
    </span>
    <Icon v-if="entry.isDir" name="folder" :size="15" class="folder" />
    <FileIcon v-else :name="entry.name" />
    <span class="name">{{ entry.name }}</span>
    <span v-if="holdsActive" class="dot" />
  </div>
  <template v-if="open && children">
    <TreeNode v-for="c in children" :key="c.path" :entry="c" :depth="depth + 1" />
  </template>
</template>

<style scoped>
.row {
  height: 24px;
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 6px;
  padding-right: 8px;
  border-radius: 6px;
  white-space: nowrap;
}
.row:hover {
  background: var(--hover);
}
.row.selected {
  background: var(--selection-inactive);
}
.row.selected.focused {
  background: var(--accent);
  color: var(--accent-text);
}
.row.selected.focused .folder,
.row.selected.focused .chev,
.row.selected.focused :deep(.fi) {
  color: var(--accent-text) !important;
}
.row {
  position: relative;
}
/* active editor file: accent bar + tint, even when the selection is somewhere else */
.row.active:not(.selected) {
  background: var(--accent-soft);
}
.row.active::before {
  content: '';
  position: absolute;
  left: -4px;
  top: 4px;
  bottom: 4px;
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
}
.row.active .name {
  font-weight: 600;
}
/* collapsed folder that contains the active file */
.dot {
  width: 5px;
  height: 5px;
  margin-left: 4px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.8;
}
.row.dimmed:not(.selected) {
  opacity: 0.5;
}
.chev {
  width: 12px;
  flex-shrink: 0;
  display: inline-flex;
  color: var(--text-dim);
}
.folder {
  color: #5ea8f2;
  flex-shrink: 0;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
