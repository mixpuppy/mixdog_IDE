/**
 * Central event bus.
 *
 * Every IDE action (file open/save/edit, build output, Tomcat logs, tool
 * downloads, commands run...) is published here. The renderer shows it in the
 * "이벤트" panel, and later the AI bridge (GPT / Claude / Gemini) subscribes to
 * the same stream so the model sees exactly what the user sees and does.
 */
import { EventEmitter } from 'events'
import { allWindows, windowsFor, currentScope } from './windows'

export interface IdeEvent {
  id: number
  time: number
  /** dotted type, e.g. "file.save", "build.output", "tomcat.start" */
  type: string
  /** "user" (UI), "system" (IDE itself), or later "ai:<model>" */
  source: string
  data: Record<string, unknown>
  /** project the event belongs to (null = IDE-wide, e.g. tool downloads) */
  project: string | null
}

const MAX = 5000
const log: IdeEvent[] = []
const emitter = new EventEmitter()
emitter.setMaxListeners(50)
let seq = 0

/** High-volume types are kept in the log but not pushed one-by-one to the event panel. */
const NOISY = new Set(['build.output', 'tomcat.output', 'git.changed', 'git.progress'])

/**
 * Publish an event. `project` scopes it to the windows showing that project; by default the
 * scope of the current IPC request is used (see core/windows.ts), and IDE-wide events go everywhere.
 */
/**
 * Console output (Maven / Gradle / Tomcat logs) can be thousands of lines a second. Lines are
 * collected for a short moment and sent to the window as one event `{ lines: [...] }`, and they are
 * not kept in the event history (they would push every other event out of it).
 */
const OUTPUT = new Set(['build.output', 'tomcat.output'])
const FLUSH_MS = 40
const outQueue = new Map<string, { type: string; project: string | null; lines: Record<string, unknown>[] }>()
let outTimer: ReturnType<typeof setTimeout> | null = null

function flushOutput(): void {
  outTimer = null
  for (const q of outQueue.values()) {
    const ev: IdeEvent = { id: ++seq, time: Date.now(), type: q.type, source: 'system', data: { lines: q.lines }, project: q.project }
    for (const w of q.project ? windowsFor(q.project) : allWindows()) w.wc.send('event:stream', ev)
  }
  outQueue.clear()
}

export function publish(type: string, data: Record<string, unknown> = {}, source = 'system', project?: string | null): IdeEvent {
  const scope = project !== undefined ? project : (currentScope() ?? null)
  const ev: IdeEvent = { id: ++seq, time: Date.now(), type, source, data, project: scope }
  if (OUTPUT.has(type)) {
    emitter.emit('event', ev)
    const k = `${type}|${scope ?? ''}`
    let q = outQueue.get(k)
    if (!q) outQueue.set(k, (q = { type, project: scope, lines: [] }))
    q.lines.push(data)
    outTimer ??= setTimeout(flushOutput, FLUSH_MS)
    return ev
  }
  log.push(ev)
  if (log.length > MAX) log.splice(0, log.length - MAX)
  emitter.emit('event', ev)
  const channel = NOISY.has(type) ? 'event:stream' : 'event'
  for (const w of scope ? windowsFor(scope) : allWindows()) w.wc.send(channel, ev)
  return ev
}

/** Subscribe to all events (future AI bridge entry point). Returns an unsubscribe fn. */
export function subscribe(fn: (ev: IdeEvent) => void): () => void {
  emitter.on('event', fn)
  return () => emitter.off('event', fn)
}

/** Recent history, optionally filtered by type prefix, e.g. history(200, 'build.'). */
export function history(limit = 500, prefix?: string, project?: string | null): IdeEvent[] {
  let list = prefix ? log.filter((e) => e.type.startsWith(prefix)) : log
  // a window's view: its own project's events plus IDE-wide ones
  if (project !== undefined) list = list.filter((e) => !e.project || (!!project && e.project.toLowerCase() === project.toLowerCase()))
  return list.slice(-limit)
}
