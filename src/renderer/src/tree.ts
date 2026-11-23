/**
 * Project tree state shared by all TreeNode rows: which folders are expanded, and
 * "select opened file" (IntelliJ): reveal the active editor's file in the tree.
 */
import { reactive, watch } from 'vue'
import { store } from './store'

const KEY = 'mixdog.treeAutoFollow'
const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

export const tree = reactive({
  /** expanded folders (normalized paths) */
  expanded: new Set<string>(),
  /** file to scroll into view once its row exists */
  reveal: null as string | null,
  /** follow the active editor automatically */
  autoFollow: (() => {
    try {
      return localStorage.getItem(KEY) !== '0'
    } catch {
      return true
    }
  })()
})

export const isExpanded = (path: string): boolean => tree.expanded.has(norm(path))
export function setExpanded(path: string, on: boolean): void {
  if (on) tree.expanded.add(norm(path))
  else tree.expanded.delete(norm(path))
}
export const samePath = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && norm(a) === norm(b)

/** Expand every folder between the project root and `path`, select it and scroll to it. */
export function revealInTree(path: string | null = store.activePath): void {
  const root = store.project?.path
  if (!path || !root || !norm(path).startsWith(norm(root) + '\\')) return
  const parts = path.slice(root.length).split(/[\\/]/).filter(Boolean)
  let cur = root
  for (const part of parts.slice(0, -1)) {
    cur = `${cur}\\${part}`
    tree.expanded.add(norm(cur))
  }
  store.selectedPath = path
  tree.reveal = norm(path)
}

/** Collapse every folder (IntelliJ "Collapse All"). */
export function collapseAll(): void {
  tree.expanded.clear()
}

export function setAutoFollow(on: boolean): void {
  tree.autoFollow = on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  if (on) revealInTree()
}

/** a new project starts collapsed */
watch(
  () => store.project?.path,
  () => {
    tree.expanded.clear()
    tree.reveal = null
  }
)

// IntelliJ "Always Select Opened File": switching editor tabs reveals the file in the tree
watch(
  () => store.activePath,
  (p) => {
    if (tree.autoFollow && p) revealInTree(p)
  }
)

export { norm as normPath }
