/**
 * Bridge to the renderer's command registry.
 *
 * Every user-facing action in the UI is a registered command
 * (src/renderer/src/commands.ts). The main process and the AI can list and invoke
 * the very same commands in a given IDE window, so "AI does X" and "user clicks X"
 * go through one code path and both show up in the event log.
 */
import { ipcMain, BrowserWindow } from 'electron'
import { allWindows, type WinCtx } from './windows'

let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

ipcMain.on('command:result', (_e, msg: { reqId: number; ok: boolean; value?: unknown; error?: string }) => {
  const p = pending.get(msg.reqId)
  if (!p) return
  pending.delete(msg.reqId)
  msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error))
})

/** The window to use when none is given: the focused one, else the most recent. */
export function defaultWindow(): WinCtx | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  const all = allWindows()
  return all.find((c) => c.win === focused) ?? all[all.length - 1]
}

/** Run a renderer command by id in a window, e.g. invokeCommand('file.open', { path }, 'ai:claude', ctx). */
export function invokeCommand(id: string, args: unknown = {}, source = 'system', ctx: WinCtx | undefined = defaultWindow()): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ctx || ctx.wc.isDestroyed()) return reject(new Error('IDE 창이 없습니다'))
    const reqId = ++seq
    pending.set(reqId, { resolve, reject })
    ctx.wc.send('command:invoke', { reqId, id, args, source })
    setTimeout(() => {
      if (pending.delete(reqId)) reject(new Error(`command timeout: ${id}`))
    }, 60_000)
  })
}
