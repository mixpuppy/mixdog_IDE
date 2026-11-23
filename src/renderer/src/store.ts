import { reactive } from 'vue'
import { createDoc, disposeDoc, docs, externalReload } from './monaco'
import { showTool, type ToolId } from './layout'

/** Error toast without importing ide.ts (which imports this module): goes through the event bus. */
function notify(message: string): void {
  window.api.events.emit('error', { message })
}

export type PanelTab = 'build' | 'tomcat' | 'events' | 'terminal' | 'problems'

export interface Tab {
  path: string
  name: string
  dirty: boolean
}

/** One editor pane of the (split) editor area: its own tabs and active file. */
export interface Group {
  id: number
  tabs: Tab[]
  activePath: string | null
}

/** Split layout tree: panes can be split right or down inside each other (IntelliJ style). */
export type LayoutNode =
  | { kind: 'leaf'; groupId: number; size: number }
  | { kind: 'split'; dir: 'row' | 'column'; children: LayoutNode[]; size: number }

let groupSeq = 1
const newGroup = (tabs: Tab[] = [], activePath: string | null = null): Group => ({ id: groupSeq++, tabs, activePath })
const firstGroup = newGroup()

export interface Project {
  path: string
  name: string
}

const RECENT_KEY = 'mixdog.recentProjects'

function loadRecent(): Project[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
  } catch {
    return []
  }
}

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export const store = reactive({
  /** editor area hidden so the Claude panel can take the whole width */
  editorHidden: loadFlag('mixdog.editorHidden'),
  project: null as Project | null,
  recent: loadRecent(),
  /** editor groups (split view); index `activeGroup` is the one with focus */
  groups: [firstGroup] as Group[],
  /** how the groups are arranged */
  editorLayout: { kind: 'leaf', groupId: firstGroup.id, size: 1 } as LayoutNode,
  activeGroup: 0,
  /** editor tab being dragged (split drop zones are shown while set) */
  tabDrag: null as { path: string; from: number } | null,
  /** tabs of the focused group */
  get tabs(): Tab[] {
    return this.groups[this.activeGroup]?.tabs ?? []
  },
  /** active file of the focused group */
  get activePath(): string | null {
    return this.groups[this.activeGroup]?.activePath ?? null
  },
  set activePath(v: string | null) {
    const g = this.groups[this.activeGroup]
    if (g) g.activePath = v
  },
  selectedPath: null as string | null,
  /** what the main area shows: code editor or the Git graph */
  mainView: 'editor' as 'editor' | 'git',
  dialog: null as null | 'project' | 'run',
  windowFocused: true,
  maximized: false,
  cursor: { line: 1, col: 1 },
  eol: 'LF',
  language: ''
})

// other IDE windows share localStorage: keep the recent list in sync with them
window.addEventListener('storage', (e) => {
  if (e.key === RECENT_KEY) store.recent = loadRecent()
})

function saveRecent(): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(store.recent.slice(0, 8)))
  } catch {
    /* storage unavailable - recent list just won't persist */
  }
}

export function setProject(p: Project): void {
  store.project = p
  store.recent = [p, ...store.recent.filter((r) => r.path !== p.path)].slice(0, 8)
  saveRecent()
  document.title = `${p.name} - mixdog IDE`
  window.api.events.emit('project.open', { path: p.path, name: p.name })
}

/** Where to open a project when this window already shows one (IntelliJ asks the same). */
async function openHere(p: Project): Promise<void> {
  if (store.project && store.project.path.toLowerCase() !== p.path.toLowerCase()) {
    const { chooseSheet } = await import('./ui')
    const i = await chooseSheet('프로젝트 열기', `'${p.name}' 을(를) 어디에서 열까요?`, ['새 창', '이 창'])
    if (i === null) return
    if (i === 0) {
      await window.api.newWindow(p.path)
      return
    }
  }
  setProject(p)
}

export async function openFolder(): Promise<void> {
  const p = await window.api.fs.openFolder()
  if (p) await openHere(p)
}

/** Pick a folder and open it in a new IDE window. */
export async function openFolderInNewWindow(): Promise<void> {
  await window.api.openFolderInNewWindow()
}

export async function openRecent(p: Project, newWindow = false): Promise<void> {
  try {
    await window.api.fs.readDir(p.path)
    if (newWindow) await window.api.newWindow(p.path)
    else await openHere(p)
  } catch {
    // a toast, not alert(): a native message box freezes the whole window until dismissed
    notify(`폴더를 찾을 수 없어 최근 목록에서 뺐습니다: ${p.path}`)
    store.recent = store.recent.filter((r) => r.path !== p.path)
    saveRecent()
  }
}

export function setEditorHidden(hidden: boolean): void {
  store.editorHidden = hidden
  try {
    localStorage.setItem('mixdog.editorHidden', hidden ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

export async function openFile(path: string, groupIndex = store.activeGroup): Promise<void> {
  store.selectedPath = path
  store.mainView = 'editor'
  // opening a file (from the tree, a shortcut or Claude) brings the editor back
  if (store.editorHidden) setEditorHidden(false)
  const g = store.groups[groupIndex] ?? store.groups[0]
  if (!g.tabs.find((t) => t.path === path)) {
    if (!docs.has(path)) {
      let content: string
      try {
        content = await window.api.fs.readFile(path)
      } catch (e) {
        notify(`파일을 열 수 없습니다: ${path} (${e})`)
        return
      }
      if (!docs.has(path)) createDoc(path, content)
    }
    g.tabs.push({ path, name: path.split(/[\\/]/).pop() ?? path, dirty: isDirty(path) })
    window.api.events.emit('file.open', { path, lines: docs.get(path)?.model.getLineCount() })
  }
  g.activePath = path
  store.activeGroup = store.groups.indexOf(g)
}

/** All tabs (in every group) showing this file. */
export function tabsOf(path: string): Tab[] {
  return store.groups.flatMap((g) => g.tabs.filter((t) => t.path === path))
}

function isDirty(path: string): boolean {
  const doc = docs.get(path)
  return !!doc && doc.model.getAlternativeVersionId() !== doc.savedVersion
}

/* ---- layout tree helpers ---- */
function findParent(node: LayoutNode, groupId: number, parent: LayoutNode | null = null): { leaf: LayoutNode; parent: LayoutNode | null } | null {
  if (node.kind === 'leaf') return node.groupId === groupId ? { leaf: node, parent } : null
  for (const c of node.children) {
    const r = findParent(c, groupId, node)
    if (r) return r
  }
  return null
}

/** Put group `newId` right of / below group `targetId`. */
function layoutSplit(targetId: number, newId: number, dir: 'row' | 'column'): void {
  const hit = findParent(store.editorLayout, targetId)
  if (!hit) return
  const { leaf, parent } = hit
  const fresh: LayoutNode = { kind: 'leaf', groupId: newId, size: 1 }
  if (parent && parent.kind === 'split' && parent.dir === dir) {
    // same direction: the two panes share the target's space
    const half = leaf.size / 2
    leaf.size = half
    fresh.size = half
    parent.children.splice(parent.children.indexOf(leaf) + 1, 0, fresh)
    return
  }
  const split: LayoutNode = { kind: 'split', dir, size: leaf.size, children: [{ ...leaf, size: 1 }, fresh] }
  if (!parent) store.editorLayout = split
  else if (parent.kind === 'split') parent.children.splice(parent.children.indexOf(leaf), 1, split)
}

function layoutRemove(groupId: number): void {
  const hit = findParent(store.editorLayout, groupId)
  if (!hit?.parent || hit.parent.kind !== 'split') return
  const parent = hit.parent
  parent.children.splice(parent.children.indexOf(hit.leaf), 1)
  if (parent.children.length === 1) {
    // collapse a split with a single child into that child
    const only = { ...parent.children[0], size: parent.size }
    const up = findParentOfNode(store.editorLayout, parent)
    if (!up) store.editorLayout = only
    else up.children.splice(up.children.indexOf(parent), 1, only)
  }
}

function findParentOfNode(root: LayoutNode, target: LayoutNode): Extract<LayoutNode, { kind: 'split' }> | null {
  if (root.kind !== 'split') return null
  for (const c of root.children) {
    if (c === target) return root
    const r = findParentOfNode(c, target)
    if (r) return r
  }
  return null
}

/** Drop a group that became empty (the last group always stays). */
function pruneGroup(g: Group): void {
  if (g.tabs.length || store.groups.length === 1) return
  const i = store.groups.indexOf(g)
  store.groups.splice(i, 1)
  layoutRemove(g.id)
  if (store.activeGroup >= store.groups.length || store.activeGroup > i) store.activeGroup = Math.max(0, store.activeGroup - 1)
}

/** Remove a tab from one group; the document is disposed only when no group shows it any more. */
function removeTab(g: Group, path: string): void {
  const i = g.tabs.findIndex((t) => t.path === path)
  if (i < 0) return
  g.tabs.splice(i, 1)
  if (g.activePath === path) g.activePath = (g.tabs[i] ?? g.tabs[i - 1])?.path ?? null
  if (!tabsOf(path).length) disposeDoc(path)
  pruneGroup(g)
}

export function closeTab(path: string, groupIndex = store.activeGroup): void {
  const g = store.groups[groupIndex]
  const tab = g?.tabs.find((t) => t.path === path)
  if (!g || !tab) return
  const last = tabsOf(path).length === 1
  if (last && tab.dirty && !confirm(`'${tab.name}' 의 변경 사항을 저장하지 않고 닫을까요?`)) return
  removeTab(g, path)
  if (last) window.api.events.emit('file.close', { path, discardedChanges: tab.dirty })
}

/** Close every tab of a group except `keep`. */
export function closeOthers(keep: string, groupIndex = store.activeGroup): void {
  const g = store.groups[groupIndex]
  if (!g) return
  for (const t of [...g.tabs]) if (t.path !== keep) closeTab(t.path, store.groups.indexOf(g))
}

/** Open the file in a new editor group next to (dir row) or below (dir column) a group. */
export function splitTab(path: string, dir: 'row' | 'column', fromIndex = store.activeGroup, move = false): void {
  const from = store.groups[fromIndex]
  const tab = from?.tabs.find((t) => t.path === path)
  if (!from || !tab) return
  const g = newGroup([{ ...tab }], path)
  store.groups.splice(fromIndex + 1, 0, g)
  layoutSplit(from.id, g.id, dir)
  if (move && from.tabs.length > 1) removeTab(from, path)
  store.activeGroup = store.groups.indexOf(g)
  window.api.events.emit('editor.split', { path, dir, groups: store.groups.length })
}

/** Drag a tab from one pane onto the edge of another: open it in a new pane next to the target. */
export function splitToGroup(path: string, dir: 'row' | 'column', fromIndex: number, targetIndex: number): void {
  const from = store.groups[fromIndex]
  const target = store.groups[targetIndex]
  const tab = from?.tabs.find((t) => t.path === path)
  if (!from || !target || !tab) return
  const g = newGroup([{ ...tab }], path)
  store.groups.splice(targetIndex + 1, 0, g)
  layoutSplit(target.id, g.id, dir)
  removeTab(from, path)
  store.activeGroup = store.groups.indexOf(g)
  window.api.events.emit('editor.split', { path, dir, groups: store.groups.length })
}

/** Move a tab to another group (drag & drop onto the group). */
export function moveTab(path: string, fromIndex: number, toIndex: number): void {
  const from = store.groups[fromIndex]
  const to = store.groups[toIndex]
  const tab = from?.tabs.find((t) => t.path === path)
  if (!from || !to || !tab || from === to) return
  if (!to.tabs.some((t) => t.path === path)) to.tabs.push({ ...tab })
  to.activePath = path
  removeTab(from, path)
  store.activeGroup = store.groups.indexOf(to)
}

/** Merge every group back into one. */
export function unsplit(): void {
  if (store.groups.length < 2) return
  const first = store.groups[0]
  const active = store.activePath
  for (const g of store.groups.slice(1)) for (const t of g.tabs) if (!first.tabs.some((x) => x.path === t.path)) first.tabs.push(t)
  store.groups.splice(1)
  store.editorLayout = { kind: 'leaf', groupId: first.id, size: 1 }
  store.activeGroup = 0
  if (active) first.activePath = active
}

export async function saveActive(): Promise<void> {
  const path = store.activePath
  if (!path) return
  const doc = docs.get(path)
  if (!doc) return
  await window.api.fs.writeFile(path, doc.model.getValue())
  doc.savedVersion = doc.model.getAlternativeVersionId()
  for (const t of tabsOf(path)) t.dirty = false
}

/** Reload an open tab from disk after an outside change (Claude, git...). Keeps unsaved edits. */
export async function reloadFromDisk(path: string): Promise<'reloaded' | 'dirty' | 'none'> {
  const doc = docs.get(path)
  const tabs = tabsOf(path)
  if (!doc || !tabs.length) return 'none'
  if (tabs.some((t) => t.dirty)) return 'dirty'
  let text: string
  try {
    text = await window.api.fs.readFile(path)
  } catch {
    return 'none' // deleted / locked
  }
  if (text === doc.model.getValue()) return 'none'
  // edit operation (not setValue) keeps undo history and the scroll position
  externalReload.active = true
  try {
    doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text }], () => null)
  } finally {
    externalReload.active = false
  }
  doc.savedVersion = doc.model.getAlternativeVersionId()
  for (const t of tabs) t.dirty = false
  return 'reloaded'
}

/** Show a tool window wherever it is docked (kept for older call sites). */
export function showPanel(tab: PanelTab | ToolId): void {
  showTool(tab as ToolId)
}

/** Path relative to the open project, split into breadcrumb parts. */
export function relativeParts(path: string): string[] {
  const root = store.project?.path
  const rel = root && path.startsWith(root) ? path.slice(root.length) : path
  return [store.project?.name ?? '', ...rel.split(/[\\/]/).filter(Boolean)]
}
