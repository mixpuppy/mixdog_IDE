/**
 * Debugger state in the renderer: breakpoints (per project, remembered), the paused location,
 * call stack and variables. Breakpoint dots and the current-line highlight are Monaco
 * decorations on the document models, so every pane showing the file draws them.
 */
import { reactive, watch } from 'vue'
import type { editor } from 'monaco-editor'
import { monaco, docs } from './monaco'
import { store } from './store'
import { showTool } from './layout'
import { openAt } from './search'
import { toast } from './ide'
import { promptText } from './ui'

export interface Bp {
  path: string
  line: number
  condition?: string
  enabled: boolean
}

export interface Frame {
  handle: string
  cls: string
  method: string
  line: number
  path: string | null
}

export interface VarNode {
  name: string
  type: string
  value: string
  ref?: string
  open?: boolean
  loading?: boolean
  children?: VarNode[]
}

export const dbg = reactive({
  breakpoints: [] as Bp[],
  /** verified breakpoints: 'path:line' (lower case) -> line the JVM stops at */
  verified: {} as Record<string, number | null>,
  muted: false,
  attached: false,
  paused: false,
  reason: '',
  thread: '',
  threads: [] as { id: string; name: string }[],
  frames: [] as Frame[],
  frame: 0,
  vars: [] as VarNode[],
  varsNote: '',
  loadingVars: false,
  /** frames list or breakpoint list on the left of the debug window */
  view: 'frames' as 'frames' | 'breakpoints'
})

const bpKey = (path: string, line: number): string => `${path.toLowerCase()}:${line}`
const storeKey = (): string => `mixdog.breakpoints:${store.project?.path.toLowerCase() ?? ''}`

function persist(): void {
  try {
    localStorage.setItem(storeKey(), JSON.stringify(dbg.breakpoints))
  } catch {
    /* storage unavailable */
  }
}

function sync(): void {
  persist()
  decorateAll()
  const p = store.project?.path
  if (!p) return
  const list = dbg.muted ? [] : JSON.parse(JSON.stringify(dbg.breakpoints))
  void window.api.debug.setBreakpoints(p, list).catch((e: Error) => toast(e.message, 'error'))
}

/* load the breakpoints of the open project */
watch(
  () => store.project?.path,
  async (p) => {
    try {
      dbg.breakpoints = JSON.parse(localStorage.getItem(storeKey()) ?? '[]')
    } catch {
      dbg.breakpoints = []
    }
    dbg.verified = {}
    if (p) {
      const st = await window.api.debug.state(p).catch(() => ({ attached: false, paused: false }))
      dbg.attached = st.attached
    }
    sync()
  },
  { immediate: true }
)

export const canBreak = (path: string | null | undefined): boolean => !!path && /\.(java|kt)$/i.test(path)

export function toggleBreakpoint(path: string, line: number): void {
  const i = dbg.breakpoints.findIndex((b) => bpKey(b.path, b.line) === bpKey(path, line))
  if (i >= 0) dbg.breakpoints.splice(i, 1)
  else dbg.breakpoints.push({ path, line, enabled: true })
  sync()
}

export function bpAt(path: string, line: number): Bp | undefined {
  return dbg.breakpoints.find((b) => bpKey(b.path, b.line) === bpKey(path, line))
}

export async function editCondition(path: string, line: number): Promise<void> {
  let bp = bpAt(path, line)
  const r = await promptText('중단점 조건', {
    message: '조건이 참일 때만 멈춥니다. 예: id == 5 · name != null · user.name.equals("홍길동") (비우면 항상 멈춤)',
    value: bp?.condition ?? '',
    ok: '저장'
  })
  if (!r) return
  if (!bp) {
    bp = { path, line, enabled: true }
    dbg.breakpoints.push(bp)
  }
  bp.condition = r.value.trim() || undefined
  sync()
}

export function setEnabled(bp: Bp, on: boolean): void {
  bp.enabled = on
  sync()
}

export function removeBreakpoint(bp: Bp): void {
  dbg.breakpoints = dbg.breakpoints.filter((b) => b !== bp)
  sync()
}

export function removeAll(): void {
  dbg.breakpoints = []
  sync()
}

export function toggleMute(): void {
  dbg.muted = !dbg.muted
  sync()
}

/* ---------------------------------------------------------------- decorations */

const decoIds = new Map<editor.ITextModel, string[]>()

function decorate(model: editor.ITextModel): void {
  const path = model.uri.fsPath.toLowerCase()
  const items: editor.IModelDeltaDecoration[] = []
  for (const b of dbg.breakpoints) {
    if (b.path.toLowerCase() !== path) continue
    const v = dbg.verified[bpKey(b.path, b.line)]
    const cls = !b.enabled || dbg.muted ? 'bp-off' : b.condition ? 'bp-cond' : dbg.attached && v === undefined ? 'bp-pending' : 'bp'
    items.push({
      range: { startLineNumber: b.line, startColumn: 1, endLineNumber: b.line, endColumn: 1 },
      options: {
        glyphMarginClassName: `bp-glyph ${cls}`,
        glyphMarginHoverMessage: { value: b.condition ? `조건: \`${b.condition}\`` : dbg.attached && v === undefined ? '아직 로드되지 않은 클래스 (실행되면 적용)' : '중단점' },
        stickiness: 1
      }
    })
  }
  const top = dbg.paused ? dbg.frames[dbg.frame] : undefined
  if (top?.path && top.path.toLowerCase() === path && top.line > 0) {
    items.push({
      range: { startLineNumber: top.line, startColumn: 1, endLineNumber: top.line, endColumn: 1 },
      options: { isWholeLine: true, className: 'exec-line', glyphMarginClassName: 'exec-glyph' }
    })
  }
  decoIds.set(model, model.deltaDecorations(decoIds.get(model) ?? [], items))
}

function decorateAll(): void {
  for (const m of monaco.editor.getModels()) decorate(m)
}

monaco.editor.onDidCreateModel((m) => decorate(m))
monaco.editor.onWillDisposeModel((m) => decoIds.delete(m))

/** breakpoints follow their line when lines are inserted / removed above them */
export function trackEdits(model: editor.ITextModel): void {
  const ids = decoIds.get(model)
  if (!ids?.length) return
  const path = model.uri.fsPath.toLowerCase()
  const mine = dbg.breakpoints.filter((b) => b.path.toLowerCase() === path)
  let moved = false
  const lines = ids.map((id) => model.getDecorationRange(id)?.startLineNumber).filter((x): x is number => !!x)
  mine.forEach((b, i) => {
    const l = lines[i]
    if (l && l !== b.line) {
      b.line = l
      moved = true
    }
  })
  if (moved) {
    persist()
    clearTimeout(moveTimer)
    moveTimer = setTimeout(sync, 1000)
  }
}
let moveTimer: ReturnType<typeof setTimeout> | undefined

/* ---------------------------------------------------------------- session events */

function onEvent(ev: { type: string; data: Record<string, unknown>; project?: string | null }): void {
  const d = ev.data ?? {}
  switch (ev.type) {
    case 'debug.attached':
      dbg.attached = true
      toast(`디버거 연결됨 (포트 ${d.port})`, 'ok')
      decorateAll()
      break
    case 'debug.detached':
      dbg.attached = false
      dbg.paused = false
      dbg.frames = []
      dbg.vars = []
      dbg.verified = {}
      decorateAll()
      break
    case 'debug.breakpoints': {
      const v: Record<string, number | null> = {}
      for (const s of d.list as { path: string; line: number; actual?: number; verified: boolean }[]) if (s.verified) v[bpKey(s.path, s.line)] = s.actual ?? s.line
      dbg.verified = v
      decorateAll()
      break
    }
    case 'debug.paused':
      dbg.paused = true
      dbg.reason = String(d.reason)
      dbg.thread = String(d.thread)
      dbg.threads = d.threads as { id: string; name: string }[]
      dbg.frames = d.frames as Frame[]
      dbg.view = 'frames'
      showTool('debug')
      void selectFrame(0, true)
      break
    case 'debug.resumed':
      dbg.paused = false
      dbg.vars = []
      dbg.varsNote = ''
      decorateAll()
      break
    case 'debug.error':
      toast(String(d.message), 'error')
      break
  }
}
window.api.events.on((ev) => onEvent(ev as never))

/* ---------------------------------------------------------------- stack / variables */

export async function selectFrame(i: number, reveal = true): Promise<void> {
  dbg.frame = i
  const f = dbg.frames[i]
  decorateAll()
  if (!f) return
  if (reveal && f.path && f.line > 0) void openAt(f.path, f.line)
  const p = store.project?.path
  if (!p) return
  dbg.loadingVars = true
  try {
    const r = await window.api.debug.variables(p, f.handle)
    if (dbg.frames[dbg.frame] !== f) return
    dbg.vars = r.vars as unknown as VarNode[]
    dbg.varsNote = r.note ?? ''
  } catch (e) {
    dbg.vars = []
    dbg.varsNote = (e as Error).message
  } finally {
    dbg.loadingVars = false
  }
}

export async function selectThread(id: string): Promise<void> {
  const p = store.project?.path
  if (!p) return
  dbg.thread = id
  try {
    dbg.frames = (await window.api.debug.threadFrames(p, id)) as unknown as Frame[]
    const firstUser = dbg.frames.findIndex((f) => f.path)
    await selectFrame(Math.max(0, firstUser), firstUser >= 0)
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}

export async function expand(n: VarNode): Promise<void> {
  if (!n.ref) return
  n.open = !n.open
  if (!n.open || n.children) return
  const p = store.project?.path
  if (!p) return
  n.loading = true
  try {
    n.children = (await window.api.debug.children(p, n.ref)) as unknown as VarNode[]
  } catch (e) {
    n.children = [{ name: '', type: '', value: (e as Error).message }]
  } finally {
    n.loading = false
  }
}

/* ---------------------------------------------------------------- run control */

const project = (): string | null => store.project?.path ?? null

export function resume(): void {
  const p = project()
  if (p && dbg.paused) void window.api.debug.resume(p).catch((e: Error) => toast(e.message, 'error'))
}

export function stepOver(): void {
  const p = project()
  if (p && dbg.paused) void window.api.debug.step(p, 1).catch((e: Error) => toast(e.message, 'error'))
}

export function stepInto(): void {
  const p = project()
  if (p && dbg.paused) void window.api.debug.step(p, 0).catch((e: Error) => toast(e.message, 'error'))
}

export function stepOut(): void {
  const p = project()
  if (p && dbg.paused) void window.api.debug.step(p, 2).catch((e: Error) => toast(e.message, 'error'))
}

export function detach(): void {
  const p = project()
  if (p) void window.api.debug.detach(p)
}

/** attach to the configured debug port by hand (Tomcat started in debug mode outside the IDE, or a failed attach) */
export async function attach(): Promise<void> {
  const p = store.project
  if (!p) return
  const port = (await promptText('디버거 연결', { message: 'JDWP 디버그 포트 (localhost)', value: '5005', ok: '연결' }))?.value
  if (!port) return
  try {
    await window.api.debug.attach(p.path, Number(port))
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}
