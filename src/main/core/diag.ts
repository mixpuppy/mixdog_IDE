/**
 * Small diagnostic log (%APPDATA%/<userData>/diag.log) for problems that are hard to catch
 * live: window focus / blur, a renderer that stops answering, main-process stalls.
 * Kept under 1 MB (the older half is dropped).
 */
import { app } from 'electron'
import { appendFile, stat, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

const file = (): string => join(app.getPath('userData'), 'diag.log')
let queue = Promise.resolve()

export function diag(what: string, data: Record<string, unknown> = {}): void {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  const line = `${ts} ${what}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`
  queue = queue
    .then(async () => {
      const f = file()
      try {
        if ((await stat(f)).size > 1024 * 1024) {
          const t = await readFile(f, 'utf-8')
          await writeFile(f, t.slice(t.length / 2), 'utf-8')
        }
      } catch {
        /* no file yet */
      }
      await appendFile(f, line, 'utf-8')
    })
    .catch(() => {})
}

export const diagFile = file

/** main-process event loop stalls (anything blocking it also delays focus events and IPC) */
export function watchStalls(): void {
  let last = Date.now()
  setInterval(() => {
    const now = Date.now()
    const gap = now - last - 500
    if (gap > 1000) diag('main.stall', { ms: gap })
    last = now
  }, 500).unref?.()
}
