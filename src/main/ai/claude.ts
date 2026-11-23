/**
 * Runs the user's own Claude Code CLI inside the IDE (in a pseudo-terminal),
 * signed in with their own subscription, and points it at the IDE tools MCP
 * server. Permission modes are Claude Code's own (Shift+Tab cycles them live).
 *
 * The IDE never touches Claude credentials; it only launches the CLI the user
 * installed and logged into, exactly as if they typed `claude` in a terminal.
 */
import { app, ipcMain, type WebContents } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, delimiter } from 'path'
import { homedir } from 'os'
import { spawnTerm, writeTerm, killTerm } from '../core/pty'
import { publish } from '../core/events'
import { mcpConfig } from './mcp-server'
import { listSessions } from './sessions'
import { ctxOf, scopeOf, type WinCtx } from '../core/windows'

export function findClaude(): string | null {
  const candidates = [
    join(homedir(), '.local', 'bin', 'claude.exe'),
    join(process.env['APPDATA'] ?? '', 'npm', 'claude.cmd'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'claude', 'claude.exe')
  ]
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    candidates.push(join(dir, 'claude.exe'), join(dir, 'claude.cmd'))
  }
  return candidates.find((p) => p && existsSync(p)) ?? null
}

const SYSTEM_APPEND =
  'You are running inside mixdog IDE, the user\'s own IDE (Java/Spring, JSP, Vue 3, Tomcat). ' +
  'The "mixdog" MCP server shows what the user sees and does: call mcp__mixdog__get_ide_state for the active file, cursor, ' +
  'selection and Tomcat status, and mcp__mixdog__get_recent_events for recent activity, whenever the request refers to ' +
  '"this file", "the error", "what I just did" and similar. Use mcp__mixdog__build_project and mcp__mixdog__run_tomcat ' +
  'to build and run (they use the project JDK and run configuration), and mcp__mixdog__open_file to show the user a location.'

export interface ClaudeStartOptions {
  /** pty id for this tab, e.g. "claude:<session id>" */
  termId: string
  /** the Claude Code session id: new uuid, or the one to resume */
  sessionId: string
  /** how to open it: new conversation, continue an existing one, or branch a copy of it */
  how: 'new' | 'resume' | 'fork'
  /** for 'fork': the session to copy from */
  fromSessionId?: string
  cwd: string
  cols: number
  rows: number
  permissionMode: 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions'
  /** put "bypass permissions" into the Shift+Tab cycle */
  allowBypass: boolean
}

/** MCP config for one window: its token makes the IDE tools act on that window's project. */
function writeMcpConfig(ctx: WinCtx): string {
  const dir = join(app.getPath('userData'), 'claude')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `mcp-mixdog-${ctx.id}.json`)
  writeFileSync(file, JSON.stringify(mcpConfig(ctx.mcpToken), null, 2), 'utf-8')
  return file
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function startClaude(o: ClaudeStartOptions, owner: WebContents): void {
  const ctx = ctxOf(owner)
  if (!ctx) throw new Error('IDE 창을 찾을 수 없습니다')
  const exe = findClaude()
  if (!exe) throw new Error('Claude Code 를 찾을 수 없습니다')
  if (!UUID.test(o.sessionId) || (o.fromSessionId && !UUID.test(o.fromSessionId))) throw new Error('잘못된 세션 ID')
  const args = ['--mcp-config', writeMcpConfig(ctx), '--allowedTools', 'mcp__mixdog', '--append-system-prompt', SYSTEM_APPEND]
  if (o.permissionMode !== 'default') args.push('--permission-mode', o.permissionMode)
  if (o.allowBypass && o.permissionMode !== 'bypassPermissions') args.push('--allow-dangerously-skip-permissions')
  if (o.how === 'new') args.push('--session-id', o.sessionId)
  else if (o.how === 'resume') args.push('--resume', o.sessionId)
  else args.push('--resume', o.fromSessionId!, '--fork-session', '--session-id', o.sessionId)
  spawnTerm({ id: o.termId, kind: 'claude', file: exe, args, cwd: o.cwd, cols: o.cols, rows: o.rows, owner })
  publish('ai.session.start', { sessionId: o.sessionId, how: o.how, from: o.fromSessionId, cwd: o.cwd, permissionMode: o.permissionMode }, 'ai:claude', scopeOf(ctx))
}

ipcMain.handle('ai:status', () => {
  const cliPath = findClaude()
  return { available: !!cliPath, cliPath }
})
ipcMain.handle('ai:start', (e, o: ClaudeStartOptions) => {
  startClaude(o, e.sender)
  return true
})
ipcMain.handle('ai:stop', (e, termId: string) => killTerm(e.sender, termId))
/** Type text into a Claude tab's prompt (e.g. "@src/Foo.java#L10-20 " or "/rename x
"). */
ipcMain.handle('ai:type', (e, termId: string, text: string) => writeTerm(e.sender, termId, text))
ipcMain.handle('ai:sessions', (_e, projectPath: string) => listSessions(projectPath))
