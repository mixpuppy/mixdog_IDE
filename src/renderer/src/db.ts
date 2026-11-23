/**
 * Database tool window state: connections, the schema tree, query consoles and their results.
 * Loaded only when the Database tool window or a .sql file is first shown.
 *
 * A query console is a real .sql file (%APPDATA%/mixdog-ide/consoles/<connection id>/<name>.sql),
 * so it opens in a normal editor tab and keeps its text between sessions, like IntelliJ consoles.
 * Any other .sql file (e.g. in the project) can be attached to a connection and run as well.
 */
import { reactive } from 'vue'
import type { editor as Editor } from 'monaco-editor'
import { openFile } from './store'
import { docs } from './monaco'
import { promptText, confirmSheet } from './ui'
import { store } from './store'
import { toast } from './ide'

export type DbKind = 'mysql' | 'mariadb' | 'postgres' | 'mssql' | 'oracle'

export interface DbConn {
  id: string
  name: string
  kind: DbKind
  host: string
  port: number
  database: string
  sid?: boolean
  user: string
  savePassword: boolean
  readOnly: boolean
  encrypt?: boolean
  hasPassword?: boolean
  connected?: boolean
}

export interface DbObject {
  name: string
  type: 'table' | 'view'
  comment: string
}

export interface DbColumn {
  name: string
  type: string
  nullable: boolean
  pk: boolean
  comment: string
}

export interface DbResult {
  columns: string[]
  rows: unknown[][]
  more: boolean
  affected: number | null
  ms: number
}

export interface ResultItem {
  sql: string
  result?: DbResult
  error?: string
}

/** results of one .sql file / console */
export interface ResultSet {
  connId: string
  running: boolean
  items: ResultItem[]
  active: number
}

interface TreeNode {
  open: boolean
  loading: boolean
  error?: string
  schemas?: string[]
  current?: string
  objects?: DbObject[]
  columns?: DbColumn[]
}

export const KINDS: { kind: DbKind; label: string }[] = [
  { kind: 'oracle', label: 'Oracle' },
  { kind: 'mariadb', label: 'MariaDB' },
  { kind: 'mysql', label: 'MySQL' },
  { kind: 'mssql', label: 'SQL Server' },
  { kind: 'postgres', label: 'PostgreSQL' }
]
export const kindLabel = (k: DbKind): string => KINDS.find((x) => x.kind === k)?.label ?? k
export const DEFAULT_PORT: Record<DbKind, number> = { mysql: 3306, mariadb: 3306, postgres: 5432, mssql: 1433, oracle: 1521 }

const SQL_CONN_KEY = 'mixdog.sqlConnections'

function loadSqlConn(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SQL_CONN_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export const db = reactive({
  conns: [] as DbConn[],
  loaded: false,
  /** tree nodes by key: id, id/schema, id/schema/table */
  tree: {} as Record<string, TreeNode>,
  selected: null as string | null,
  /** connection being edited in the dialog ('' id = new) */
  editing: null as DbConn | null,
  results: {} as Record<string, ResultSet>,
  /** project .sql file -> connection id */
  sqlConn: loadSqlConn(),
  /** result panel height (px) */
  resultHeight: Number(localStorage.getItem('mixdog.dbResultHeight')) || 260,
  consolesDir: ''
})

/** passwords typed for connections that don't store one (kept in memory for this window only) */
const typed = new Map<string, string>()

export async function loadConnections(): Promise<void> {
  if (!db.consolesDir) db.consolesDir = await window.api.db.consolesDir()
  db.conns = (await window.api.db.list()) as unknown as DbConn[]
  db.loaded = true
}

export const connOf = (id: string): DbConn | undefined => db.conns.find((c) => c.id === id)

function notify(message: string, level: 'error' | 'ok' = 'error'): void {
  toast(message, level)
}

/* ---------------------------------------------------------------- connect */

async function passwordFor(c: DbConn): Promise<string | null | undefined> {
  if (c.hasPassword || c.connected) return null
  if (typed.has(c.id)) return typed.get(c.id)!
  const r = await promptText(`${c.name} 비밀번호`, { message: `${c.user}@${c.host}`, password: true, ok: '연결' })
  if (!r) return undefined
  typed.set(c.id, r.value)
  return r.value
}

/** Make sure the connection is open (asks for the password when it is not stored). false = cancelled / failed. */
export async function ensureConnected(id: string, quiet = false): Promise<boolean> {
  const c = connOf(id)
  if (!c) return false
  if (c.connected) return true
  const pw = await passwordFor(c)
  if (pw === undefined) return false
  try {
    await window.api.db.connect(id, pw)
    c.connected = true
    return true
  } catch (e) {
    typed.delete(id) // probably a wrong password: ask again next time
    if (!quiet) notify(`${c.name} 연결 실패: ${(e as Error).message}`)
    return false
  }
}

export async function disconnect(id: string): Promise<void> {
  await window.api.db.disconnect(id)
  const c = connOf(id)
  if (c) c.connected = false
  for (const k of Object.keys(db.tree)) if (k === id || k.startsWith(id + '/')) delete db.tree[k]
}

/* ---------------------------------------------------------------- tree */

const node = (key: string): TreeNode => (db.tree[key] ??= { open: false, loading: false })
export const nodeOf = (key: string): TreeNode | undefined => db.tree[key]

async function load(key: string, fn: (n: TreeNode) => Promise<void>): Promise<void> {
  const n = node(key)
  n.loading = true
  n.error = undefined
  try {
    await fn(n)
  } catch (e) {
    n.error = (e as Error).message
  } finally {
    n.loading = false
  }
}

export async function toggleConn(id: string, force?: boolean): Promise<void> {
  const n = node(id)
  n.open = force ?? !n.open
  if (!n.open || n.schemas) return
  if (!(await ensureConnected(id))) {
    n.open = false
    return
  }
  await load(id, async (n) => {
    const r = await window.api.db.schemas(id)
    n.schemas = r.schemas
    n.current = r.current
  })
  // IntelliJ opens the default schema right away
  if (n.current) void toggleSchema(id, n.current, true)
}

export async function toggleSchema(id: string, schema: string, force?: boolean): Promise<void> {
  const key = `${id}/${schema}`
  const n = node(key)
  n.open = force ?? !n.open
  if (!n.open || n.objects) return
  await load(key, async (n) => {
    n.objects = (await window.api.db.objects(id, schema)) as unknown as DbObject[]
  })
}

export async function toggleTable(id: string, schema: string, table: string): Promise<void> {
  const key = `${id}/${schema}/${table}`
  const n = node(key)
  n.open = !n.open
  if (!n.open || n.columns) return
  await load(key, async (n) => {
    n.columns = await columnsOf(id, schema, table)
  })
}

export async function columnsOf(id: string, schema: string, table: string): Promise<DbColumn[]> {
  const key = `${id}/${schema}/${table}`
  const cached = db.tree[key]?.columns
  if (cached) return cached
  const cols = (await window.api.db.columns(id, schema, table)) as unknown as DbColumn[]
  node(key).columns = cols
  return cols
}

/** Drop cached metadata (after DDL, or the refresh button). */
export async function refresh(id?: string): Promise<void> {
  await loadConnections()
  const ids = id ? [id] : Object.keys(db.tree).filter((k) => !k.includes('/'))
  for (const cid of ids) {
    const wasOpen = db.tree[cid]?.open
    const openSchemas = Object.entries(db.tree)
      .filter(([k, n]) => k.startsWith(cid + '/') && k.split('/').length === 2 && n.open)
      .map(([k]) => k.split('/')[1])
    for (const k of Object.keys(db.tree)) if (k === cid || k.startsWith(cid + '/')) delete db.tree[k]
    if (wasOpen && connOf(cid)?.connected) {
      await toggleConn(cid, true)
      for (const s of openSchemas) void toggleSchema(cid, s, true)
    }
  }
}

/* ---------------------------------------------------------------- SQL text */

export function quoteIdent(kind: DbKind, name: string): string {
  if (kind === 'mysql' || kind === 'mariadb') return '`' + name.replace(/`/g, '``') + '`'
  if (kind === 'mssql') return '[' + name.replace(/]/g, ']]') + ']'
  const plain = kind === 'oracle' ? /^[A-Z][A-Z0-9_$#]*$/ : /^[a-z_][a-z0-9_$]*$/
  return plain.test(name) ? name : '"' + name.replace(/"/g, '""') + '"'
}

export function qualified(c: DbConn, schema: string, table: string): string {
  const cur = db.tree[c.id]?.current
  const t = quoteIdent(c.kind, table)
  return schema && schema !== cur ? `${quoteIdent(c.kind, schema)}.${t}` : t
}

export function selectSql(c: DbConn, schema: string, table: string, cols?: string[]): string {
  const list = cols?.length ? cols.map((x) => quoteIdent(c.kind, x)).join(', ') : '*'
  return `SELECT ${list}\nFROM ${qualified(c, schema, table)}`
}

const PLSQL_START = /^(begin|declare|create\s+(or\s+replace\s+)?(procedure|function|package|trigger|type))\b/i

export interface Stmt {
  text: string
  start: number
  end: number
}

/**
 * Split a script into statements at ';' outside strings / comments.
 * Oracle PL/SQL blocks (BEGIN / DECLARE / CREATE PROCEDURE ...) end at a line holding only '/'.
 */
export function splitStatements(src: string): Stmt[] {
  const out: Stmt[] = []
  let start = 0
  let i = 0
  const push = (end: number, next: number): void => {
    const raw = src.slice(start, end)
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text && !/^(--[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)+$/.test(text)) out.push({ text, start: start + lead, end: start + lead + text.length })
    start = next
  }
  const plsqlAt = (): boolean => {
    let t = src.slice(start, i).replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '')
    t = t.trimStart()
    return PLSQL_START.test(t)
  }
  while (i < src.length) {
    const ch = src[i]
    const two = src.slice(i, i + 2)
    if (two === '--') {
      const e = src.indexOf('\n', i)
      i = e < 0 ? src.length : e + 1
    } else if (two === '/*') {
      const e = src.indexOf('*/', i + 2)
      i = e < 0 ? src.length : e + 2
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === ch) {
          if (src[j + 1] === ch) j += 2
          else break
        } else j++
      }
      i = j + 1
    } else if (ch === ';' && !plsqlAt()) {
      push(i, i + 1)
      i++
    } else if (ch === '/' && (i === 0 || src[i - 1] === '\n') && /^\/[ \t]*(\r?\n|$)/.test(src.slice(i))) {
      // a line with only '/': ends a PL/SQL block (SQL*Plus style)
      push(i, i + 1)
      i++
    } else if (ch === '\n' && /^\n[ \t]*\r?\n/.test(src.slice(i)) && !plsqlAt()) {
      // a blank line also separates statements (IntelliJ does the same for the statement under the caret)
      push(i, i + 1)
      i++
    } else i++
  }
  push(src.length, src.length)
  return out
}

/** The statement under the caret (or the closest one before it). */
export function statementAt(src: string, offset: number): Stmt | null {
  const list = splitStatements(src)
  let best: Stmt | null = null
  for (const s of list) {
    if (offset >= s.start && offset <= s.end + 1) return s
    if (s.end < offset) best = s
  }
  return best ?? list[0] ?? null
}

/* ---------------------------------------------------------------- run */

export const isSqlPath = (p: string | null | undefined): boolean => !!p && /\.sql$/i.test(p)

/** connection a .sql path runs against: consoles by folder, other files by the remembered choice */
export function connIdOf(path: string): string | null {
  if (db.consolesDir && path.toLowerCase().startsWith(db.consolesDir.toLowerCase())) {
    return path.slice(db.consolesDir.length + 1).split(/[\\/]/)[0] || null
  }
  return db.sqlConn[path] ?? null
}

export function setSqlConn(path: string, id: string | null): void {
  if (id) db.sqlConn[path] = id
  else delete db.sqlConn[path]
  try {
    localStorage.setItem(SQL_CONN_KEY, JSON.stringify(db.sqlConn))
  } catch {
    /* storage unavailable */
  }
}

export const isConsole = (path: string): boolean => !!db.consolesDir && path.toLowerCase().startsWith(db.consolesDir.toLowerCase())

/** Run statements of a .sql file; results go to the file's result panel. */
export async function runSql(path: string, statements: string[]): Promise<void> {
  const id = connIdOf(path)
  if (!id || !connOf(id)) {
    notify('이 SQL 파일에 연결할 DB 를 먼저 고르세요 (편집기 위 DB 선택)')
    return
  }
  if (!statements.length) return
  const prev = db.results[path]
  if (prev?.running) return
  if (!(await ensureConnected(id))) return
  db.results[path] = { connId: id, running: true, items: [], active: 0 }
  // work on the reactive proxy (not the plain object) so the result panel updates
  const rs = db.results[path]
  try {
    for (const sql of statements) {
      rs.items.push({ sql })
      const item = rs.items[rs.items.length - 1]
      rs.active = rs.items.length - 1
      try {
        item.result = (await window.api.db.query(id, sql)) as unknown as DbResult
      } catch (e) {
        item.error = (e as Error).message
        break // stop the script at the first error, like IntelliJ
      }
      if (/^\s*(create|alter|drop|rename|truncate)\b/i.test(sql)) void refresh(id)
    }
    // show the last statement that returned rows (scripts often end with a SELECT)
    const lastRows = rs.items.map((x, i) => (x.result?.columns.length || x.error ? i : -1)).filter((i) => i >= 0).pop()
    if (lastRows !== undefined) rs.active = lastRows
  } finally {
    rs.running = false
  }
}

/** Ctrl+Enter in a .sql editor: run the selection, or the statement under the caret. */
export async function runFromEditor(ed: Editor.IStandaloneCodeEditor, path: string): Promise<void> {
  const model = ed.getModel()
  if (!model) return
  const sel = ed.getSelection()
  let statements: string[]
  if (sel && !sel.isEmpty()) {
    statements = splitStatements(model.getValueInRange(sel)).map((s) => s.text)
  } else {
    const pos = ed.getPosition()
    const src = model.getValue()
    const s = statementAt(src, pos ? model.getOffsetAt(pos) : 0)
    if (!s) return
    // flash the statement that runs
    const r = { start: model.getPositionAt(s.start), end: model.getPositionAt(s.end) }
    const deco = ed.createDecorationsCollection([
      {
        range: { startLineNumber: r.start.lineNumber, startColumn: r.start.column, endLineNumber: r.end.lineNumber, endColumn: r.end.column },
        options: { className: 'sql-running', isWholeLine: false }
      }
    ])
    setTimeout(() => deco.clear(), 600)
    statements = [s.text]
  }
  await runSql(path, statements)
}

/** Run every statement of the file (toolbar ▶▶). */
export async function runAll(path: string): Promise<void> {
  const doc = docs.get(path)
  if (!doc) return
  await runSql(
    path,
    splitStatements(doc.model.getValue()).map((s) => s.text)
  )
}

export function stopQuery(path: string): void {
  const rs = db.results[path]
  if (!rs?.running) return
  // closing the connection is the one cancel every driver supports; the next query reconnects
  void disconnect(rs.connId).then(() => {
    const it = rs.items[rs.items.length - 1]
    if (it && !it.result) it.error = '사용자가 중지했습니다 (연결을 닫았습니다)'
    rs.running = false
  })
}

/* ---------------------------------------------------------------- consoles */

/** Open (or create) the query console of a connection; optionally add SQL at the end and run it. */
export async function openConsole(id: string, sql?: string, run = false): Promise<void> {
  if (!db.consolesDir) await loadConnections()
  if (!connOf(id)) return
  const path = await window.api.db.consoleFile(id)
  await openFile(path)
  if (!sql) return
  const doc = docs.get(path)
  if (!doc) return
  const m = doc.model
  const text = m.getValue()
  const sep = text.endsWith('\n\n') || !text ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  const line = m.getLineCount()
  const col = m.getLineMaxColumn(line)
  m.pushEditOperations([], [{ range: { startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col }, text: `${sep}${sql};\n` }], () => null)
  // the console is a scratch file: keep it saved
  await window.api.fs.writeFile(path, m.getValue())
  doc.savedVersion = m.getAlternativeVersionId()
  for (const g of store.groups) for (const t of g.tabs) if (t.path === path) t.dirty = false
  if (run) await runSql(path, [sql])
}

/* ---------------------------------------------------------------- edit */

export function newConnection(): void {
  db.editing = { id: '', name: '', kind: 'oracle', host: 'localhost', port: 1521, database: '', user: '', savePassword: true, readOnly: false }
  store.dialog = 'db'
}

export function editConnection(id: string, copy = false): void {
  const c = connOf(id)
  if (!c) return
  db.editing = copy ? { ...c, id: '', name: c.name + ' 복사본', hasPassword: false, connected: false } : { ...c }
  store.dialog = 'db'
}

export async function removeConnection(id: string): Promise<void> {
  const c = connOf(id)
  if (!c) return
  if (!(await confirmSheet('DB 연결 삭제', `'${c.name}' 연결 설정을 삭제할까요? (DB 자체는 그대로입니다)`, '삭제', true))) return
  await window.api.db.delete(id)
  typed.delete(id)
  await loadConnections()
}

export function rememberTypedPassword(id: string, pw: string): void {
  typed.set(id, pw)
}
