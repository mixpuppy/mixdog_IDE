import { contextBridge, ipcRenderer } from 'electron'

/* Shared shapes (kept loose here; the renderer has typed copies in types.ts) */
type Obj = Record<string, unknown>
type TxState = { manual: boolean; pending: boolean; count: number }

const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

async function dbInvoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as { value?: T; error?: string }
  if (r && 'error' in r && r.error !== undefined) throw new Error(r.error)
  return r.value as T
}

const api = {
  initialProject: (): Promise<{ path: string; name: string } | null> => invoke('app:initialProject'),
  /** open another IDE window (optionally with a project folder) */
  newWindow: (path?: string | null): Promise<boolean> => invoke('app:newWindow', path ?? null),
  /** pick a folder and open it in a new window */
  openFolderInNewWindow: (): Promise<boolean> => invoke('app:openFolderInNewWindow'),
  window: {
    close: () => ipcRenderer.send('window:close'),
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    onState: (cb: (s: { maximized: boolean }) => void) => ipcRenderer.on('window:state', (_e, s) => cb(s)),
    onFocus: (cb: (focused: boolean) => void) => ipcRenderer.on('window:focus', (_e, f) => cb(f)),
    /** a line in the diagnostic log (diag.log in the user data folder) */
    diag: (what: string, data: Obj = {}) => ipcRenderer.send('window:diag', what, data)
  },
  fs: {
    openFolder: (): Promise<{ path: string; name: string } | null> => invoke('fs:openFolder'),
    readDir: (dir: string): Promise<{ name: string; path: string; isDir: boolean }[]> => invoke('fs:readDir', dir),
    readFile: (path: string): Promise<string> => invoke('fs:readFile', path),
    writeFile: (path: string, content: string): Promise<boolean> => invoke('fs:writeFile', path, content)
  },
  /** Event bus - everything the IDE does, for the event panel and the future AI bridge. */
  events: {
    emit: (type: string, data: Obj = {}, source = 'user') => ipcRenderer.send('events:emit', type, data, source),
    history: (limit?: number, prefix?: string) => invoke('events:history', limit, prefix),
    on: (cb: (ev: Obj) => void) => ipcRenderer.on('event', (_e, ev) => cb(ev)),
    onStream: (cb: (ev: Obj) => void) => ipcRenderer.on('event:stream', (_e, ev) => cb(ev))
  },
  /** Main process (and later AI) asks the renderer to run a registered command. */
  commands: {
    onInvoke: (cb: (req: { reqId: number; id: string; args: unknown; source: string }) => void) =>
      ipcRenderer.on('command:invoke', (_e, req) => cb(req)),
    reply: (reqId: number, ok: boolean, value?: unknown, error?: string) =>
      ipcRenderer.send('command:result', { reqId, ok, value, error })
  },
  project: {
    info: (path: string, name: string) => invoke<Obj>('project:info', path, name),
    save: (path: string, settings: unknown) => invoke('project:save', path, settings),
    deployable: (path: string) => invoke<string | null>('project:deployable', path)
  },
  jdk: {
    list: () => invoke<Obj[]>('jdk:list'),
    download: (major: number) => invoke<Obj | null>('jdk:download', major),
    add: () => invoke<Obj | null>('jdk:add')
  },
  maven: {
    download: () => invoke<string>('maven:download')
  },
  tomcat: {
    list: () => invoke<Obj[]>('tomcat:list'),
    download: (major: number) => invoke<Obj | null>('tomcat:download', major),
    add: () => invoke<Obj | null>('tomcat:add')
  },
  build: {
    run: (path: string, name: string) => invoke<boolean>('build:run', path, name),
    stop: (path: string) => invoke('build:stop', path),
    /** run specific goals / tasks with the project JDK */
    goals: (path: string, name: string, goals: string) => invoke<boolean>('build:goals', path, name, goals),
    /** re-resolve dependencies, checking remote repositories for updates */
    updateDeps: (path: string, name: string) => invoke<boolean>('build:updateDeps', path, name),
    gradleTasks: (path: string, name: string) => invoke<string>('build:gradleTasks', path, name),
    check: (path: string, name: string) => invoke<{ ok: boolean; problems: Obj[] }>('build:check', path, name),
    problems: (path: string) => invoke<Obj[]>('build:problems', path)
  },
  run: {
    start: (path: string, name: string, debug: boolean) => invoke<boolean>('run:start', path, name, debug),
    stop: (path: string) => invoke('run:stop', path),
    /** leave this project's Tomcat running when the IDE quits */
    keepOnQuit: (path: string) => invoke('run:keepOnQuit', path),
    state: (path: string) => invoke<{ tomcat: string; building: boolean }>('run:state', path)
  },
  /** Pseudo-terminals (PowerShell panel, Claude Code) */
  pty: {
    shell: (id: string, cwd: string, cols: number, rows: number) => invoke('pty:shell', id, cwd, cols, rows),
    write: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string) => invoke('pty:kill', id),
    onData: (cb: (id: string, data: string) => void) => ipcRenderer.on('pty:data', (_e, id, data) => cb(id, data)),
    onExit: (cb: (id: string, code: number) => void) => ipcRenderer.on('pty:exit', (_e, id, code) => cb(id, code))
  },
  /** Claude Code (the user's own CLI + subscription) running in a pty, connected to the IDE MCP server */
  ai: {
    status: () => invoke<{ available: boolean; cliPath: string | null }>('ai:status'),
    start: (o: {
      termId: string
      sessionId: string
      how: 'new' | 'resume' | 'fork'
      fromSessionId?: string
      cwd: string
      cols: number
      rows: number
      permissionMode: string
      allowBypass: boolean
    }) => invoke('ai:start', o),
    stop: (termId: string) => invoke('ai:stop', termId),
    type: (termId: string, text: string) => invoke('ai:type', termId, text),
    sessions: (projectPath: string) => invoke<Obj[]>('ai:sessions', projectPath)
  },
  /** Project search: file list, Find in Path, Replace in Path */
  /** debugger (JDWP to Tomcat's debug port) */
  debug: {
    setBreakpoints: (project: string, list: { path: string; line: number; condition?: string; enabled: boolean }[]) => invoke('debug:setBreakpoints', project, list),
    state: (project: string) => invoke<{ attached: boolean; paused: boolean }>('debug:state', project),
    attach: (project: string, port: number) => invoke('debug:attach', project, port),
    detach: (project: string) => invoke('debug:detach', project),
    resume: (project: string) => invoke('debug:resume', project),
    step: (project: string, depth: 0 | 1 | 2) => invoke('debug:step', project, depth),
    variables: (project: string, frame: string) => invoke<{ vars: Obj[]; note?: string }>('debug:variables', project, frame),
    children: (project: string, ref: string) => invoke<Obj[]>('debug:children', project, ref),
    threadFrames: (project: string, thread: string) => invoke<Obj[]>('debug:threadFrames', project, thread)
  },
  /** Ctrl+click / F12: declarations of the symbol at an offset (text rules, no language server) */
  nav: {
    definition: (project: string, path: string, text: string, offset: number) =>
      invoke<{ path: string; line: number; col: number }[]>('nav:definition', project, path, text, offset)
  },
  search: {
    files: (p: string, fresh?: boolean) => invoke<string[]>('search:files', p, fresh),
    find: (p: string, o: unknown) => invoke<Obj>('search:find', p, o),
    replace: (p: string, o: unknown, replacement: string, files: string[]) => invoke<{ files: number; replaced: number }>('search:replace', p, o, replacement, files)
  },
  /** Git (the user's own git.exe and credentials) */
  git: {
    status: (p: string) => invoke<Obj | null>('git:status', p),
    refs: (p: string) => invoke<Obj>('git:refs', p),
    log: (p: string, limit?: number, scope?: 'all' | 'current', compare?: string | null) => invoke<Obj>('git:log', p, limit, scope, compare),
    commit: (p: string, hash: string) => invoke<Obj>('git:commit', p, hash),
    fileAt: (p: string, rev: string, path: string) => invoke<{ text: string | null; binary: boolean }>('git:fileAt', p, rev, path),
    diffText: (p: string, spec: unknown, context: number, ignoreWs: boolean) => invoke<string>('git:diffText', p, spec, context, ignoreWs),
    applyHunk: (p: string, spec: unknown, context: number, index: number, header: string, action: 'stage' | 'unstage' | 'discard') =>
      invoke('git:applyHunk', p, spec, context, index, header, action),
    stage: (p: string, paths: string[]) => invoke('git:stage', p, paths),
    unstage: (p: string, paths: string[]) => invoke('git:unstage', p, paths),
    discard: (p: string, files: { path: string; untracked: boolean }[]) => invoke('git:discard', p, files),
    doCommit: (p: string, message: string, amend: boolean) => invoke<string>('git:doCommit', p, message, amend),
    checkout: (p: string, target: string) => invoke('git:checkout', p, target),
    createBranch: (p: string, name: string, start: string | null, checkout: boolean) => invoke('git:createBranch', p, name, start, checkout),
    recent: (p: string) => invoke<string[]>('git:recent', p),
    renameBranch: (p: string, from: string, to: string) => invoke('git:renameBranch', p, from, to),
    openMr: (p: string, branch: string, target: string | null) => invoke<string>('git:openMr', p, branch, target),
    deleteBranch: (p: string, name: string, force: boolean) => invoke('git:deleteBranch', p, name, force),
    merge: (p: string, name: string) => invoke<string>('git:merge', p, name),
    abort: (p: string) => invoke('git:abort', p),
    fetch: (p: string) => invoke<string>('git:fetch', p),
    pull: (p: string) => invoke<string>('git:pull', p),
    push: (p: string, force: boolean) => invoke<string>('git:push', p, force),
    stashPush: (p: string, message: string) => invoke('git:stashPush', p, message),
    stash: (p: string, action: 'pop' | 'apply' | 'drop', index: number) => invoke('git:stash', p, action, index),
    reset: (p: string, hash: string, mode: 'soft' | 'mixed' | 'hard') => invoke('git:reset', p, hash, mode),
    revert: (p: string, hash: string) => invoke('git:revert', p, hash),
    cherryPick: (p: string, hash: string) => invoke('git:cherryPick', p, hash),
    init: (p: string) => invoke('git:init', p)
  },
  /** Database connections and queries (errors come back as rejected promises, without an IDE toast) */
  db: {
    list: () => dbInvoke<Obj[]>('db:list'),
    save: (conn: unknown, password: string | null) => dbInvoke<Obj>('db:save', conn, password),
    delete: (id: string) => dbInvoke('db:delete', id),
    test: (conn: unknown, password: string | null) => dbInvoke<string>('db:test', conn, password),
    connect: (id: string, password?: string | null) => dbInvoke<{ version: string; current: string }>('db:connect', id, password),
    disconnect: (id: string) => dbInvoke('db:disconnect', id),
    schemas: (id: string) => dbInvoke<{ schemas: string[]; current: string }>('db:schemas', id),
    objects: (id: string, schema: string) => dbInvoke<Obj[]>('db:objects', id, schema),
    columns: (id: string, schema: string, table: string) => dbInvoke<Obj[]>('db:columns', id, schema, table),
    query: (id: string, sql: string, limit?: number, password?: string | null) => dbInvoke<Obj>('db:query', id, sql, limit, password),
    saveChanges: (id: string, statements: { sql: string; params: unknown[]; expect?: number }[], password?: string | null) =>
      dbInvoke<{ affected: number; tx: TxState }>('db:save-changes', id, statements, password),
    tx: (id: string) => dbInvoke<TxState>('db:tx', id),
    setManual: (id: string, on: boolean) => dbInvoke<TxState>('db:setManual', id, on),
    commit: (id: string) => dbInvoke<TxState>('db:commit', id),
    pending: (id: string) => dbInvoke<{ sql: string; at: number; affected: number | null; from: 'console' | 'grid' }[]>('db:pending', id),
    rollback: (id: string) => dbInvoke<TxState>('db:rollback', id),
    consolesDir: () => dbInvoke<string>('db:consolesDir'),
    consoleFile: (id: string) => dbInvoke<string>('db:consoleFile', id),
    oracleClient: () => dbInvoke<string | null>('db:oracleClient'),
    setOracleClient: (v: string | null) => dbInvoke('db:setOracleClient', v),
    pickFolder: (title: string) => dbInvoke<string | null>('db:pickFolder', title)
  },
  openExternal: (url: string) => invoke('shell:openExternal', url)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
