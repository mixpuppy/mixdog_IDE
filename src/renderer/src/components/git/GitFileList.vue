<script setup lang="ts">
/** A list of changed files (unstaged / staged / commit files) with hover actions. */
import FileIcon from '../FileIcon.vue'
import { git, STATUS_LABEL, type FileChange } from '../../git'

const props = defineProps<{
  files: FileChange[]
  /** which status letter to show: x (index/commit) or y (worktree) */
  letter: 'x' | 'y'
  /** hover action button label + handler */
  actionLabel?: string
  activePath?: string | null
}>()
const emit = defineEmits<{ open: [f: FileChange]; action: [f: FileChange]; menu: [e: MouseEvent, f: FileChange] }>()

function code(f: FileChange): string {
  return f.x === '?' ? '?' : props.letter === 'x' ? f.x : f.y
}
function name(p: string): string {
  return p.split('/').pop() ?? p
}
function dir(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}
void git
</script>

<template>
  <div class="files">
    <div
      v-for="f in files"
      :key="f.path"
      class="file"
      :class="{ on: activePath === f.path }"
      :title="f.from ? `${f.from} → ${f.path}` : f.path"
      @click="emit('open', f)"
      @contextmenu="emit('menu', $event, f)"
    >
      <FileIcon :name="name(f.path)" />
      <span class="name">{{ name(f.path) }}</span>
      <span class="dir">{{ dir(f.path) }}</span>
      <button v-if="actionLabel" class="act" @click.stop="emit('action', f)">{{ actionLabel }}</button>
      <span class="code" :class="'s-' + (code(f) === '?' ? 'n' : code(f))" :title="STATUS_LABEL[code(f)]">{{ code(f) === '?' ? 'N' : code(f) }}</span>
    </div>
  </div>
</template>

<style scoped>
.file {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 25px;
  padding: 0 10px 0 12px;
  white-space: nowrap;
}
.file:hover {
  background: var(--hover);
}
.file.on {
  background: var(--accent-soft);
}
.name {
  flex-shrink: 0;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-faint);
  font-size: 11.5px;
  direction: rtl;
  text-align: left;
}
.act {
  display: none;
  flex-shrink: 0;
  height: 19px;
  padding: 0 7px;
  border-radius: 5px;
  font-size: 11px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
}
.file:hover .act {
  display: inline-block;
}
.act:hover {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.code {
  width: 16px;
  flex-shrink: 0;
  text-align: center;
  font-family: var(--font-code);
  font-size: 11px;
  font-weight: 700;
}
.s-M {
  color: #ff9f0a;
}
.s-A,
.s-n {
  color: var(--green);
}
.s-D {
  color: var(--red);
}
.s-R,
.s-C {
  color: #64d2ff;
}
.s-U {
  color: var(--red);
}
</style>
