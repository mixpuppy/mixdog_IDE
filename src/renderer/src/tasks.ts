/**
 * Background tasks the IDE is running (build, Tomcat start, git pull/push/fetch,
 * downloads...). Shown in the status bar with the dog progress bar, and as a list
 * when clicked. Fed by the event bus, so tasks started by Claude show up too.
 */
import { reactive } from 'vue'
import { store } from './store'

export interface Task {
  id: string
  title: string
  detail: string
  /** 0-100, or null when the length is unknown (the dog just runs) */
  pct: number | null
  started: number
  /** optional cancel action */
  cancel?: () => unknown
  source?: string
}

export const tasks = reactive({ list: [] as Task[], open: false })

export function startTask(t: Omit<Task, 'started' | 'detail' | 'pct'> & Partial<Pick<Task, 'detail' | 'pct'>>): void {
  const existing = tasks.list.find((x) => x.id === t.id)
  if (existing) Object.assign(existing, t)
  else tasks.list.push({ detail: '', pct: null, started: Date.now(), ...t })
}

export function updateTask(id: string, patch: Partial<Pick<Task, 'detail' | 'pct' | 'title'>>): void {
  const t = tasks.list.find((x) => x.id === id)
  if (t) Object.assign(t, patch)
}

export function endTask(id: string): void {
  const i = tasks.list.findIndex((x) => x.id === id)
  if (i >= 0) tasks.list.splice(i, 1)
  if (!tasks.list.length) tasks.open = false
}

/** "Receiving objects:  45% (90/200)" -> 45 */
export function percentIn(line: string): number | null {
  const m = line.match(/(\d{1,3})%/)
  return m ? Math.min(100, Number(m[1])) : null
}

export function elapsed(t: Task, now = Date.now()): string {
  const s = Math.floor((now - t.started) / 1000)
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`
}

const BUILD = 'build'
const TOMCAT = 'tomcat'
const who = (src: unknown): string | undefined => (typeof src === 'string' && src.startsWith('ai:') ? 'Claude' : undefined)

function onEvent(ev: { type: string; source?: string; data: Record<string, unknown> }): void {
  const d = ev.data ?? {}
  switch (ev.type) {
    case 'build.start':
      startTask({
        id: BUILD,
        title: `빌드 (${d.tool === 'gradle' ? 'Gradle' : 'Maven'})`,
        detail: String(d.goals ?? ''),
        cancel: () => store.project && window.api.build.stop(store.project.path),
        source: who(ev.source)
      })
      break
    case 'build.output': {
      const line = String(d.line ?? '').trim()
      // Maven "[INFO] Building foo 1.0 [2/5]" gives a real fraction for multi-module builds
      const m = line.match(/\[(\d+)\/(\d+)\]\s*$/)
      if (line) updateTask(BUILD, { detail: line.replace(/^\[(INFO|WARNING)\]\s*/, '').slice(0, 160), ...(m ? { pct: Math.round(((Number(m[1]) - 1) / Number(m[2])) * 100) } : {}) })
      break
    }
    case 'build.end':
      endTask(BUILD)
      break
    case 'tomcat.start':
      startTask({ id: TOMCAT, title: `Tomcat ${d.version ?? ''} 시작`, detail: String(d.url ?? ''), cancel: () => store.project && window.api.run.stop(store.project.path), source: who(ev.source) })
      break
    case 'tomcat.output': {
      const line = String(d.line ?? '').trim()
      if (line) updateTask(TOMCAT, { detail: line.slice(0, 160) })
      break
    }
    case 'tomcat.started':
    case 'tomcat.stop':
    case 'tomcat.error':
      endTask(TOMCAT)
      break
    case 'tools.download.start':
      startTask({ id: `dl:${d.label}`, title: `${d.label} 다운로드`, pct: 0 })
      break
    case 'tools.download.progress':
      updateTask(`dl:${d.label}`, { pct: Number(d.pct) || 0, detail: d.phase === 'extract' ? '압축 푸는 중…' : '' })
      break
    case 'tools.download.done':
    case 'tools.download.error':
      endTask(`dl:${d.label}`)
      break
    case 'git.progress':
      for (const t of tasks.list.filter((x) => x.id.startsWith('git:'))) {
        const line = String(d.line ?? '')
        updateTask(t.id, { detail: line.slice(0, 160), pct: percentIn(line) ?? t.pct })
      }
      break
  }
}

window.api.events.on((ev) => onEvent(ev as never))
window.api.events.onStream((ev) => onEvent(ev as never))
