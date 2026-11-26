/**
 * Tool window layout (IntelliJ style): every tool window lives in one of three docks
 * (left / right / bottom), can be dragged to another dock, and the arrangement is remembered.
 *
 * Tool contents are rendered once and teleported into their dock (ToolHost.vue), so moving
 * a window never restarts it (the terminal keeps its shell, consoles keep their output).
 */
import { reactive, watch } from 'vue'

export type DockId = 'left' | 'right' | 'bottom'
export type ToolId = 'project' | 'search' | 'git' | 'server' | 'buildtool' | 'database' | 'build' | 'tomcat' | 'events' | 'terminal' | 'problems' | 'debug' | 'mr'

export const TOOLS: Record<ToolId, { title: string; icon: string; hint?: string }> = {
  project: { title: '프로젝트', icon: 'folder', hint: 'Alt+1' },
  search: { title: '검색', icon: 'search', hint: 'Ctrl+Shift+F' },
  git: { title: 'Git', icon: 'git', hint: 'Alt+9' },
  server: { title: '서버', icon: 'server' },
  buildtool: { title: 'Maven', icon: 'maven' },
  database: { title: '데이터베이스', icon: 'database' },
  build: { title: '빌드', icon: 'hammer' },
  tomcat: { title: 'Tomcat', icon: 'server' },
  events: { title: '이벤트', icon: 'pulse' },
  terminal: { title: '터미널', icon: 'terminal', hint: 'Alt+F12' },
  problems: { title: '문제', icon: 'warning' },
  debug: { title: '디버그', icon: 'bug', hint: 'Shift+F9' },
  mr: { title: '머지 리퀘스트', icon: 'mergeRequest' }
}

/** titles that depend on the project, e.g. "Maven" / "Gradle" for the build tool window */
export const titleOverride = reactive<Partial<Record<ToolId, string>>>({})
export const toolTitle = (id: ToolId): string => titleOverride[id] ?? TOOLS[id].title

const DEFAULT = {
  docks: {
    left: ['project', 'search', 'git', 'server'] as ToolId[],
    // IntelliJ keeps Maven / Gradle on the right
    right: ['buildtool', 'database', 'mr'] as ToolId[],
    bottom: ['build', 'tomcat', 'debug', 'events', 'terminal', 'problems'] as ToolId[]
  },
  active: { left: 'project', right: null, bottom: 'build' } as Record<DockId, ToolId | null>,
  open: { left: true, right: false, bottom: false } as Record<DockId, boolean>,
  size: { left: 270, right: 340, bottom: 240 } as Record<DockId, number>
}

const KEY = 'mixdog.layout'

function load(): typeof DEFAULT {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!saved?.docks) return structuredClone(DEFAULT)
    // keep only known tools, and add tools that are new since the layout was saved
    const all = Object.keys(TOOLS) as ToolId[]
    const seen = new Set<ToolId>()
    for (const d of ['left', 'right', 'bottom'] as DockId[]) {
      saved.docks[d] = (saved.docks[d] ?? []).filter((t: ToolId) => all.includes(t) && !seen.has(t) && seen.add(t))
    }
    for (const t of all) {
      if (seen.has(t)) continue
      // a tool added since the layout was saved goes to its default dock
      const home = (['left', 'right', 'bottom'] as DockId[]).find((d) => DEFAULT.docks[d].includes(t)) ?? 'bottom'
      saved.docks[home].push(t)
    }
    return { ...structuredClone(DEFAULT), ...saved }
  } catch {
    return structuredClone(DEFAULT)
  }
}

export const layout = reactive({
  ...load(),
  /** tool being dragged (drop zones are shown while set) */
  dragging: null as ToolId | null,
  /** bumped when a dock's body element is (re)created, so tools re-attach to the new element */
  dockEpoch: { left: 0, right: 0, bottom: 0 } as Record<DockId, number>
})

// An IDE opens on its project: whichever dock holds the Project tool shows it at start
// (the saved layout may have ended on Git or another tool last time).
{
  const home = (['left', 'right', 'bottom'] as DockId[]).find((d) => layout.docks[d].includes('project'))
  if (home) {
    layout.active[home] = 'project'
    layout.open[home] = true
  }
}

watch(
  () => [layout.docks, layout.active, layout.open, layout.size],
  () => {
    try {
      const { docks, active, open, size } = layout
      localStorage.setItem(KEY, JSON.stringify({ docks, active, open, size }))
    } catch {
      /* storage unavailable */
    }
  },
  { deep: true }
)

const mountedDocks = new Set<DockId>()
/** Called when a dock's body element is created. Only a re-creation (not the first mount) needs a re-attach. */
export function dockMounted(d: DockId): void {
  if (mountedDocks.has(d)) layout.dockEpoch[d]++
  else mountedDocks.add(d)
}
/** changes only when some dock body was re-created; moving a tool does not change it (no remount) */
export const dockGeneration = (): number => layout.dockEpoch.left + layout.dockEpoch.right + layout.dockEpoch.bottom

export function dockOf(id: ToolId): DockId {
  return (['left', 'right', 'bottom'] as DockId[]).find((d) => layout.docks[d].includes(id)) ?? 'left'
}

export function isToolVisible(id: ToolId): boolean {
  const d = dockOf(id)
  return layout.open[d] && layout.active[d] === id
}

export function showTool(id: ToolId): void {
  const d = dockOf(id)
  layout.active[d] = id
  layout.open[d] = true
}

/** IntelliJ behaviour: clicking the visible tool window's button hides it. */
export function toggleTool(id: ToolId): void {
  if (isToolVisible(id)) layout.open[dockOf(id)] = false
  else showTool(id)
}

export function hideDock(d: DockId): void {
  layout.open[d] = false
}

/** Move a tool window to a dock (optionally before `index`) and show it there. */
export function moveTool(id: ToolId, to: DockId, index?: number): void {
  const from = dockOf(id)
  // dropped back where it already is: nothing to move, just show it
  if (from === to && index === undefined) {
    showTool(id)
    return
  }
  const src = layout.docks[from]
  const oldIndex = src.indexOf(id)
  src.splice(oldIndex, 1)
  const dst = layout.docks[to]
  let i = index ?? dst.length
  if (from === to && index !== undefined && oldIndex < index) i--
  dst.splice(Math.max(0, Math.min(i, dst.length)), 0, id)
  if (from !== to && layout.active[from] === id) {
    layout.active[from] = src[0] ?? null
    if (!src.length) layout.open[from] = false
  }
  showTool(id)
}

export function resetLayout(): void {
  const d = structuredClone(DEFAULT)
  layout.docks = d.docks
  layout.active = d.active
  layout.open = d.open
  layout.size = d.size
}

/* ---- drag & drop (HTML5) ---- */
export const DND_TYPE = 'application/x-mixdog-tool'

export function onToolDragStart(e: DragEvent, id: ToolId): void {
  e.dataTransfer?.setData(DND_TYPE, id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  // let the browser grab the drag image first, then show the drop zones
  setTimeout(() => (layout.dragging = id), 0)
}

export function onToolDragEnd(): void {
  layout.dragging = null
}
