/**
 * IDE windows. Each window works on its own project; events, terminals, commands and the
 * Claude connection (MCP token) are routed per window, so two projects can be worked on
 * side by side (IntelliJ "Open in New Window").
 */
import { randomBytes } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'
import type { BrowserWindow, WebContents } from 'electron'

export interface WinCtx {
  id: number
  win: BrowserWindow
  wc: WebContents
  /** project folder open in this window (null = welcome screen) */
  project: string | null
  /** project to open right after the window loads (new window / command line) */
  initialProject: string | null
  /** bearer token Claude sessions of this window use to reach the IDE MCP server */
  mcpToken: string
}

const ctxs = new Map<number, WinCtx>()

export function registerWindow(win: BrowserWindow, initialProject: string | null): WinCtx {
  const ctx: WinCtx = { id: win.webContents.id, win, wc: win.webContents, project: null, initialProject, mcpToken: randomBytes(24).toString('hex') }
  ctxs.set(ctx.id, ctx)
  win.on('closed', () => ctxs.delete(ctx.id))
  return ctx
}

export const allWindows = (): WinCtx[] => [...ctxs.values()].filter((c) => !c.wc.isDestroyed())
export const ctxOf = (wc: WebContents | null | undefined): WinCtx | undefined => (wc ? ctxs.get(wc.id) : undefined)
export const ctxByToken = (token: string): WinCtx | undefined => allWindows().find((c) => c.mcpToken === token)

const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
export const samePath = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && norm(a) === norm(b)

/** Scope of a window: its project, or "win:<id>" while it shows the welcome screen. */
export const scopeOf = (ctx: WinCtx | undefined): string | null => (ctx ? ctx.project ?? `win:${ctx.id}` : null)

/** Windows showing this project (or any window when the path is inside it), or the window of a "win:<id>" scope. */
export function windowsFor(project: string): WinCtx[] {
  if (project.startsWith('win:')) return allWindows().filter((c) => `win:${c.id}` === project)
  const p = norm(project)
  return allWindows().filter((c) => c.project && (norm(c.project) === p || p.startsWith(norm(c.project) + '\\')))
}

/* ---- scope: which project the current work belongs to ----
 * IPC handlers run inside the sender window's scope, so events published while handling
 * a request (and from async work it starts) reach only that window. */
const scopeStore = new AsyncLocalStorage<string | null>()

export function runInScope<T>(project: string | null, fn: () => T): T {
  return scopeStore.run(project, fn)
}

export const currentScope = (): string | null | undefined => scopeStore.getStore()
