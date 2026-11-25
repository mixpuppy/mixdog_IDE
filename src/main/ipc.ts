/** IPC handlers for project settings, JDK / Maven / Tomcat, build and run. */
import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { publish, history } from './core/events'
import { getProject, setProject, getTools, setTools, type ProjectSettings } from './core/settings'
import { listJdks, downloadJdk, detectProjectJava, pickJdk, inspectJdk } from './tools/jdk'
import { detectBuild, downloadMaven, stopBuild, isBuilding } from './tools/build'
import { buildProject, startRun, stopAll, runGoals, updateDependencies, listGradleTasks, checkCompile } from './actions'
import { getProblems } from './tools/problems'
import { findDefinition } from './tools/navigate'
import * as Dbg from './debug/session'
import * as G from './tools/git'
import * as S from './tools/search'
import { listTomcats, downloadTomcat, tomcatState, inspectTomcat, findDeployable, keepOnQuit } from './tools/tomcat'
import { ctxOf, runInScope, scopeOf } from './core/windows'
import { syncWatchers } from './core/watcher'
import * as D from './tools/db'

/**
 * Wrap a handler: it runs in the sender window's project scope (so its events reach only that
 * window), and failures become a published event plus a clean error message.
 */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>): void {
  ipcMain.handle(channel, async (e, ...args) => {
    return runInScope(scopeOf(ctxOf(e.sender)), async () => {
      try {
        return await fn(...(args as A))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        publish('error', { channel, message })
        throw new Error(message)
      }
    })
  })
}

async function browseFolder(title: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const r = await (win
    ? dialog.showOpenDialog(win, { title, properties: ['openDirectory'] })
    : dialog.showOpenDialog({ title, properties: ['openDirectory'] }))
  return r.canceled ? null : r.filePaths[0]
}

/* ---------- events (AI observation log) ---------- */
ipcMain.on('events:emit', (e, type: string, data: Record<string, unknown>, source = 'user') => {
  const ctx = ctxOf(e.sender)
  // a window opened a project: remember it and (re)arrange the file / .git watchers
  if (type === 'project.open' && ctx && typeof data.path === 'string') {
    ctx.project = data.path
    syncWatchers()
    G.syncGitWatchers()
  }
  publish(type, data, source, scopeOf(ctx))
})
ipcMain.handle('events:history', (e, limit?: number, prefix?: string) => history(limit, prefix, ctxOf(e.sender)?.project ?? null))

/* ---------- project ---------- */
handle('project:info', async (path: string, name: string) => {
  const settings = getProject(path, name)
  const [build, detectedJava, jdks] = await Promise.all([detectBuild(path), detectProjectJava(path), listJdks()])
  // First open: choose a JDK that matches the project's Java version.
  if (!settings.jdkHome || !jdks.some((j) => j.home === settings.jdkHome)) {
    settings.jdkHome = pickJdk(jdks, detectedJava)?.home ?? null
    setProject(path, settings)
  }
  const jdk = jdks.find((j) => j.home === settings.jdkHome) ?? null
  const tomcat = settings.run.tomcatHome ? await inspectTomcat(settings.run.tomcatHome) : null
  return { settings, build, detectedJava, jdk, tomcat }
})

handle('project:save', async (path: string, settings: ProjectSettings) => {
  setProject(path, settings)
  publish('project.settings', { path, jdkHome: settings.jdkHome, run: settings.run })
  return true
})

handle('project:deployable', async (path: string) => findDeployable(path))

/* ---------- JDK ---------- */
handle('jdk:list', async () => listJdks())
handle('jdk:download', async (major: number) => downloadJdk(major))
handle('jdk:add', async () => {
  const dir = await browseFolder('JDK 폴더 선택')
  if (!dir) return null
  const info = await inspectJdk(dir)
  if (!info) throw new Error('JDK 폴더가 아닙니다 (bin\\javac.exe 없음)')
  setTools({ extraJdks: [...new Set([...getTools().extraJdks, dir])] })
  return info
})

/* ---------- Maven ---------- */
handle('maven:download', async () => downloadMaven())

/* ---------- Tomcat ---------- */
handle('tomcat:list', async () => listTomcats())
handle('tomcat:download', async (major: number) => downloadTomcat(major))
handle('tomcat:add', async () => {
  const dir = await browseFolder('Tomcat 폴더 선택')
  if (!dir) return null
  const info = await inspectTomcat(dir)
  if (!info) throw new Error('Tomcat 폴더가 아닙니다 (bin\\catalina.bat 없음)')
  setTools({ extraTomcats: [...new Set([...getTools().extraTomcats, dir])] })
  return info
})

/* ---------- build & run ---------- */
handle('build:run', async (path: string, name: string) => buildProject(path, name))
handle('build:stop', async (path: string) => stopBuild(path))
handle('build:goals', async (path: string, name: string, goals: string) => runGoals(path, name, goals))
handle('build:updateDeps', async (path: string, name: string) => updateDependencies(path, name))
handle('build:check', async (path: string, name: string) => checkCompile(path, name))
handle('nav:definition', async (project: string, path: string, text: string, offset: number) => findDefinition(project, path, text, offset))
handle('debug:setBreakpoints', async (project: string, list: Dbg.Breakpoint[]) => Dbg.setBreakpoints(project, list))
handle('debug:state', async (project: string) => Dbg.debugState(project))
handle('debug:attach', async (project: string, port: number) => Dbg.attachDebugger(project, port))
handle('debug:detach', async (project: string) => Dbg.detachDebugger(project))
handle('debug:resume', async (project: string) => Dbg.resume(project))
handle('debug:step', async (project: string, depth: 0 | 1 | 2) => Dbg.step(project, depth))
handle('debug:variables', async (project: string, frame: string) => Dbg.variables(project, frame))
handle('debug:children', async (project: string, ref: string) => Dbg.children(project, ref))
handle('debug:threadFrames', async (project: string, thread: string) => Dbg.threadFrames(project, thread))
handle('build:problems', async (path: string) => getProblems(path))
handle('build:gradleTasks', async (path: string, name: string) => listGradleTasks(path, name))
handle('run:start', async (path: string, name: string, debug: boolean) => {
  await startRun(path, name, debug)
  return true
})
handle('run:keepOnQuit', async (path: string) => keepOnQuit(path))
handle('run:stop', async (path: string) => {
  await stopAll(path)
  return true
})
handle('run:state', async (path: string) => ({ tomcat: tomcatState(path), building: isBuilding(path) }))

handle('shell:openExternal', async (url: string) => {
  if (/^https?:\/\/localhost[:/]/.test(url)) await shell.openExternal(url)
  return true
})

/* ---------- search ---------- */
handle('search:files', async (p: string, fresh?: boolean) => S.listFiles(p, fresh))
handle('search:find', async (p: string, o: S.FindOptions) => S.findInPath(p, o))
handle('search:replace', async (p: string, o: S.FindOptions, replacement: string, files: string[]) => S.replaceInPath(p, o, replacement, files))

/* ---------- Git ---------- */
handle('git:status', async (p: string) => G.status(p))
handle('git:refs', async (p: string) => G.refs(p))
handle('git:log', async (p: string, limit?: number, scope?: 'all' | 'current', compare?: string | null) => G.log(p, limit, scope, compare ?? null))
handle('git:commit', async (p: string, hash: string) => G.commitDetail(p, hash))
handle('git:fileAt', async (p: string, rev: string, path: string) => G.fileAt(p, rev, path))
handle('git:diffText', async (p: string, spec: G.DiffSpec, context: number, ignoreWs: boolean) => G.diffText(p, spec, context, ignoreWs))
handle('git:applyHunk', async (p: string, spec: G.DiffSpec, context: number, index: number, header: string, action: 'stage' | 'unstage' | 'discard') =>
  G.applyHunk(p, spec, context, index, header, action)
)
handle('git:stage', async (p: string, paths: string[]) => G.stage(p, paths))
handle('git:unstage', async (p: string, paths: string[]) => G.unstage(p, paths))
handle('git:discard', async (p: string, files: { path: string; untracked: boolean }[]) => G.discard(p, files))
handle('git:doCommit', async (p: string, message: string, amend: boolean) => G.commit(p, message, amend))
handle('git:checkout', async (p: string, target: string) => G.checkout(p, target))
handle('git:createBranch', async (p: string, name: string, start: string | null, co: boolean) => G.createBranch(p, name, start, co))
handle('git:recent', async (p: string) => G.recentBranches(p))
handle('git:renameBranch', async (p: string, from: string, to: string) => G.renameBranch(p, from, to))
handle('git:openMr', async (p: string, branch: string, target: string | null) => G.openMergeRequest(p, branch, target))
handle('git:deleteBranch', async (p: string, name: string, force: boolean) => G.deleteBranch(p, name, force))
handle('git:merge', async (p: string, name: string) => G.merge(p, name))
handle('git:abort', async (p: string) => G.abortOperation(p))
handle('git:fetch', async (p: string) => G.fetchAll(p))
handle('git:pull', async (p: string) => G.pull(p))
handle('git:push', async (p: string, force: boolean) => G.push(p, force))
handle('git:stashPush', async (p: string, message: string) => G.stashPush(p, message))
handle('git:stash', async (p: string, action: 'pop' | 'apply' | 'drop', index: number) => G.stashAction(p, action, index))
handle('git:reset', async (p: string, hash: string, mode: 'soft' | 'mixed' | 'hard') => G.resetTo(p, hash, mode))
handle('git:revert', async (p: string, hash: string) => G.revert(p, hash))
handle('git:cherryPick', async (p: string, hash: string) => G.cherryPick(p, hash))
handle('git:init', async (p: string) => G.init(p))

/* ---------- Database ---------- */
/**
 * DB calls answer { value } / { error } instead of throwing: a failed query (syntax error,
 * wrong password) is shown in the result panel, not as an IDE error toast.
 */
function dbHandle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>): void {
  ipcMain.handle(channel, async (e, ...args) =>
    runInScope(scopeOf(ctxOf(e.sender)), async () => {
      try {
        return { value: await fn(...(args as A)) }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    })
  )
}
dbHandle('db:list', async () => D.listConnections())
dbHandle('db:save', async (conn: D.DbConn, password: string | null) => D.saveConnection(conn, password))
dbHandle('db:delete', async (id: string) => D.deleteConnection(id))
dbHandle('db:test', async (conn: D.DbConn, password: string | null) => D.testConnection(conn, password))
dbHandle('db:connect', async (id: string, password?: string | null) => D.connect(id, password))
dbHandle('db:disconnect', async (id: string) => D.disconnect(id))
dbHandle('db:schemas', async (id: string) => D.listSchemas(id))
dbHandle('db:objects', async (id: string, schema: string) => D.listObjects(id, schema))
dbHandle('db:columns', async (id: string, schema: string, table: string) => D.listColumns(id, schema, table))
dbHandle('db:query', async (id: string, sql: string, limit?: number, password?: string | null) => D.runQuery(id, sql, { limit, password }))
dbHandle('db:save-changes', async (id: string, statements: D.DbStatement[], password?: string | null) => D.saveChanges(id, statements, password))
dbHandle('db:tx', async (id: string) => D.txState(id))
dbHandle('db:setManual', async (id: string, on: boolean) => D.setManualCommit(id, on))
dbHandle('db:commit', async (id: string) => D.commit(id))
dbHandle('db:rollback', async (id: string) => D.rollback(id))
dbHandle('db:consolesDir', async () => D.consolesDir())
dbHandle('db:consoleFile', async (id: string) => D.consoleFile(id))
dbHandle('db:oracleClient', async () => D.getOracleClient())
dbHandle('db:setOracleClient', async (v: string | null) => D.setOracleClient(v))
dbHandle('db:pickFolder', async (title: string) => browseFolder(title))
