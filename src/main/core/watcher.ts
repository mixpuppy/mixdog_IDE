/**
 * Watches every project open in an IDE window for changes made outside the editor
 * (Claude Code, git, the build...) and publishes `file.changed` to that project's
 * windows, so open tabs reload and the change shows up in the event log.
 */
import { watch, statSync, type FSWatcher } from 'fs'
import { join, sep } from 'path'
import { publish } from './events'
import { allWindows } from './windows'

const IGNORE = /(^|[\\/])(node_modules|target|build|out|dist|\.git|\.idea|\.gradle|\.mixdog)([\\/]|$)/

const TEMP = /\.tmp\.\d+\.[0-9a-f]+$|~$|\.swp$/i

/** one watcher per open project folder (lower-cased path) */
const watchers = new Map<string, FSWatcher>()
const pending = new Map<string, ReturnType<typeof setTimeout>>()
/** Paths the IDE itself just wrote - not "external" changes. */
const ownWrites = new Map<string, number>()

export function markOwnWrite(path: string): void {
  ownWrites.set(path.toLowerCase(), Date.now())
}

function watchProject(dir: string): FSWatcher | null {
  try {
    return watch(dir, { recursive: true }, (_ev, file) => {
      if (!file || IGNORE.test(file)) return
      const full = join(dir, file)
      clearTimeout(pending.get(full))
      pending.set(
        full,
        setTimeout(() => {
          pending.delete(full)
          const own = ownWrites.get(full.toLowerCase())
          if (own && Date.now() - own < 1500) return
          // atomic-write temp files (Foo.java.tmp.1234.abcd) and folder entries are noise
          if (TEMP.test(file)) return
          try {
            if (statSync(full).isDirectory()) return
          } catch {
            /* deleted - still report it */
          }
          publish('file.changed', { path: full, relative: file.split(sep).join('/') }, 'system', dir)
        }, 250)
      )
    })
  } catch (e) {
    publish('error', { message: `파일 감시 실패: ${e}` }, 'system', dir)
    return null
  }
}

/** Start watchers for newly opened projects and stop the ones no window shows any more. */
export function syncWatchers(): void {
  const open = new Map<string, string>()
  for (const w of allWindows()) if (w.project) open.set(w.project.toLowerCase(), w.project)
  for (const [k, w] of watchers) {
    if (open.has(k)) continue
    w.close()
    watchers.delete(k)
  }
  for (const [k, dir] of open) {
    if (watchers.has(k)) continue
    const w = watchProject(dir)
    if (w) watchers.set(k, w)
  }
}
