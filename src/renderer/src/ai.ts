/**
 * AI assistant state: Claude Code sessions shown as tabs in the AI panel.
 *
 * Each tab runs the user's own `claude` CLI in its own pty, bound to a
 * Claude Code session id (new, resumed or forked). Past sessions of the
 * project are listed from Claude Code's own transcripts, including ones
 * started in the Claude app, and can be reopened in a tab.
 */
import { reactive } from 'vue'
import { store } from './store'
import { editorRef } from './monaco'

export type AiMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions'

export const MODES: { id: AiMode; label: string; desc: string }[] = [
  { id: 'default', label: '수동 승인', desc: '파일 수정·명령 실행 전에 매번 확인' },
  { id: 'acceptEdits', label: '편집 자동 수락', desc: '파일 수정은 바로 적용, 명령 실행은 확인' },
  { id: 'auto', label: '자동', desc: 'Claude Code 가 안전하다고 판단한 작업은 바로 실행, 나머지만 확인' },
  { id: 'plan', label: '계획', desc: '코드를 고치지 않고 계획만 세움' },
  { id: 'bypassPermissions', label: '권한 무시', desc: '확인 없이 모든 작업 실행 (주의)' }
]

export interface SessionInfo {
  id: string
  title: string
  titleSource: 'custom' | 'ai' | 'prompt' | 'none'
  updated: number
  created: number | null
  prompts: number
  entrypoint: string
  lastPrompt: string
}

export interface AiTab {
  termId: string
  sessionId: string
  how: 'new' | 'resume' | 'fork'
  fromSessionId?: string
  title: string
  /** project folder the session runs in */
  cwd: string
  /** exit code once the process ended by itself */
  exited: number | null
  /** bump to restart the terminal */
  epoch: number
}

const PREF_KEY = 'mixdog.ai'
function loadPrefs(): { startMode: AiMode; allowBypass: boolean; width: number } {
  try {
    return { startMode: 'default', allowBypass: true, width: 560, ...JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') }
  } catch {
    return { startMode: 'default', allowBypass: true, width: 560 }
  }
}
const prefs = loadPrefs()

export const ai = reactive({
  available: null as null | boolean,
  cliPath: '',
  visible: false,
  width: prefs.width,
  startMode: prefs.startMode,
  allowBypass: prefs.allowBypass,
  tabs: [] as AiTab[],
  active: null as string | null,
  /** session list view instead of the active terminal */
  showList: true,
  /** panel is wide enough to show the session list beside the conversation */
  wide: false,
  sessions: [] as SessionInfo[],
  loadingSessions: false
})

export function savePrefs(): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ startMode: ai.startMode, allowBypass: ai.allowBypass, width: ai.width }))
  } catch {
    /* storage unavailable */
  }
}

export async function checkAvailable(): Promise<void> {
  const s = await window.api.ai.status()
  ai.available = s.available
  ai.cliPath = s.cliPath ?? ''
}

export async function refreshSessions(): Promise<void> {
  if (!store.project) {
    ai.sessions = []
    return
  }
  ai.loadingSessions = true
  try {
    ai.sessions = (await window.api.ai.sessions(store.project.path)) as unknown as SessionInfo[]
    // keep tab titles in sync with Claude's own titles (auto title / /rename)
    for (const t of ai.tabs) {
      const s = ai.sessions.find((x) => x.id === t.sessionId)
      if (s && s.titleSource !== 'none') t.title = s.title
    }
  } finally {
    ai.loadingSessions = false
  }
}

export const activeTab = (): AiTab | undefined => ai.tabs.find((t) => t.termId === ai.active)

function addTab(tab: Omit<AiTab, 'termId' | 'exited' | 'epoch' | 'cwd'>): void {
  if (!store.project) return
  savePrefs()
  const t: AiTab = { ...tab, termId: `claude:${tab.sessionId}`, cwd: store.project.path, exited: null, epoch: 0 }
  ai.tabs.push(t)
  ai.active = t.termId
  if (!ai.wide) ai.showList = false
  ai.visible = true
  window.api.events.emit('ai.tab.open', { sessionId: t.sessionId, how: t.how, from: t.fromSessionId ?? null })
}

export function newSession(): void {
  addTab({ sessionId: crypto.randomUUID(), how: 'new', title: '새 세션' })
}

/** Open a past session in a tab (or switch to it if it's already open). */
export function openSession(s: SessionInfo): void {
  const open = ai.tabs.find((t) => t.sessionId === s.id)
  if (open) {
    ai.active = open.termId
    if (!ai.wide) ai.showList = false
    return
  }
  addTab({ sessionId: s.id, how: 'resume', title: s.title })
}

/** Branch a copy of a session: same history, new id - the original stays untouched. */
export function forkSession(s: SessionInfo): void {
  addTab({ sessionId: crypto.randomUUID(), how: 'fork', fromSessionId: s.id, title: `${s.title} (분기)` })
}

export function closeTab(termId: string): void {
  const i = ai.tabs.findIndex((t) => t.termId === termId)
  if (i < 0) return
  window.api.ai.stop(termId)
  ai.tabs.splice(i, 1)
  if (ai.active === termId) {
    ai.active = (ai.tabs[i] ?? ai.tabs[i - 1])?.termId ?? null
    if (!ai.active) ai.showList = true
  }
  setTimeout(refreshSessions, 500)
}

/** After the process exited: start it again on the same session (continues the conversation). */
export function restartTab(t: AiTab): void {
  t.how = 'resume'
  t.fromSessionId = undefined
  t.exited = null
  t.epoch++
}

/** Starts the pty for a tab once its terminal view knows its size. */
export function starter(t: AiTab) {
  return (cols: number, rows: number): Promise<unknown> =>
    window.api.ai.start({
      termId: t.termId,
      sessionId: t.sessionId,
      how: t.how,
      fromSessionId: t.fromSessionId,
      cwd: t.cwd,
      cols,
      rows,
      permissionMode: ai.startMode,
      allowBypass: ai.allowBypass
    })
}

/** Rename via Claude Code's own /rename, so the Claude app sees the same name. */
export function renameTab(t: AiTab, name: string): void {
  const n = name.replace(/[\r\n]/g, ' ').trim()
  if (!n || t.exited !== null) return
  t.title = n
  window.api.ai.type(t.termId, `/rename ${n}\r`)
}

/** Cycle Claude Code's permission mode in the active tab, exactly like Shift+Tab. */
export function cycleMode(): void {
  if (ai.active) window.api.pty.write(ai.active, '\x1b[Z')
}

/** Mention the active file / selection in the active Claude tab: "@src/Foo.java#L10-20 ". */
export function sendSelectionToClaude(): void {
  if (!store.project || !store.activePath) return
  const tab = activeTab()
  if (!tab || tab.exited !== null) {
    ai.visible = true
    ai.showList = true
    return
  }
  const root = store.project.path
  const rel = store.activePath.startsWith(root) ? store.activePath.slice(root.length + 1) : store.activePath
  const sel = editorRef.current?.getSelection()
  let ref = '@' + rel.replace(/\\/g, '/')
  if (sel && !sel.isEmpty()) {
    ref += sel.startLineNumber === sel.endLineNumber ? `#L${sel.startLineNumber}` : `#L${sel.startLineNumber}-${sel.endLineNumber}`
  }
  ai.visible = true
  if (!ai.wide) ai.showList = false
  window.api.ai.type(tab.termId, ref + ' ')
  window.api.events.emit('ai.mention', { ref, sessionId: tab.sessionId })
}

/** "3분 전", "어제", "11/12" */
export function ago(ms: number): string {
  const d = (Date.now() - ms) / 1000
  if (d < 60) return '방금'
  if (d < 3600) return `${Math.floor(d / 60)}분 전`
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`
  if (d < 172800) return '어제'
  if (d < 604800) return `${Math.floor(d / 86400)}일 전`
  const t = new Date(ms)
  return `${t.getMonth() + 1}/${t.getDate()}`
}

/** Type a prepared request into the active Claude tab (the user reviews it and presses Enter). */
export function typeToClaude(text: string): boolean {
  const tab = activeTab()
  ai.visible = true
  if (!tab || tab.exited !== null) {
    ai.showList = true
    return false
  }
  if (!ai.wide) ai.showList = false
  window.api.ai.type(tab.termId, text)
  return true
}
