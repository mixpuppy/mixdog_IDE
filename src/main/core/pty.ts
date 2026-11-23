/**
 * Pseudo-terminals (Windows ConPTY via node-pty) for the terminal panel and
 * for running Claude Code inside the IDE.
 */
import { ipcMain, type WebContents } from 'electron'
import { spawn, type IPty } from '@lydell/node-pty'
import { publish } from './events'
import { ctxOf, scopeOf } from './windows'

interface Term {
  pty: IPty
  kind: string
  /** window that shows this terminal (output goes only there) */
  owner: WebContents
  project: string | null
  /** killed by the IDE (restart / new session / close) - not a real exit to report */
  killed: boolean
}

/** keyed by window + id: every window has its own "shell" terminal and Claude tabs */
const terms = new Map<string, Term>()
const key = (owner: WebContents, id: string): string => `${owner.id}:${id}`

export interface SpawnSpec {
  id: string
  kind: string
  file: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  cols: number
  rows: number
  /** window the terminal belongs to */
  owner: WebContents
}

export function spawnTerm(spec: SpawnSpec): void {
  killTerm(spec.owner, spec.id)
  const target = spec.owner
  const k = key(target, spec.id)
  const project = scopeOf(ctxOf(target))
  const pty = spawn(spec.file, spec.args, {
    name: 'xterm-256color',
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env } as Record<string, string>
  })
  const term: Term = { pty, kind: spec.kind, killed: false, owner: target, project }
  terms.set(k, term)
  // The same id is reused when a session restarts, so only the *current* process
  // may talk to the view. A replaced or deliberately killed one stays silent.
  const isCurrent = (): boolean => terms.get(k) === term
  pty.onData((data) => {
    if (isCurrent() && !target.isDestroyed()) target.send('pty:data', spec.id, data)
  })
  pty.onExit(({ exitCode }) => {
    const current = isCurrent()
    if (current) terms.delete(k)
    publish('terminal.exit', { id: spec.id, kind: spec.kind, exitCode, killedByIde: term.killed }, 'system', project)
    if (!current || term.killed) return
    if (!target.isDestroyed()) target.send('pty:exit', spec.id, exitCode)
  })
  publish('terminal.start', { id: spec.id, kind: spec.kind, file: spec.file, cwd: spec.cwd }, 'system', project)
}

export function writeTerm(owner: WebContents, id: string, data: string): void {
  terms.get(key(owner, id))?.pty.write(data)
}

export function killTerm(owner: WebContents, id: string): void {
  const k = key(owner, id)
  const t = terms.get(k)
  if (!t) return
  t.killed = true
  terms.delete(k)
  try {
    t.pty.kill()
  } catch {
    /* already gone */
  }
}

function killWhere(match: (t: Term) => boolean): void {
  for (const [k, t] of [...terms.entries()]) {
    if (!match(t)) continue
    t.killed = true
    terms.delete(k)
    try {
      t.pty.kill()
    } catch {
      /* already gone */
    }
  }
}

export function killAllTerms(): void {
  killWhere(() => true)
}

/** A window closed: end its shells and Claude sessions. */
export function killWindowTerms(owner: WebContents): void {
  killWhere((t) => t.owner === owner)
}

ipcMain.handle('pty:shell', (e, id: string, cwd: string, cols: number, rows: number) => {
  spawnTerm({ id, kind: 'shell', file: 'powershell.exe', args: ['-NoLogo'], cwd, cols, rows, owner: e.sender })
  return true
})
ipcMain.on('pty:write', (e, id: string, data: string) => writeTerm(e.sender, id, data))
ipcMain.on('pty:resize', (e, id: string, cols: number, rows: number) => {
  try {
    terms.get(key(e.sender, id))?.pty.resize(Math.max(2, cols), Math.max(2, rows))
  } catch {
    /* exited */
  }
})
ipcMain.handle('pty:kill', (e, id: string) => killTerm(e.sender, id))
