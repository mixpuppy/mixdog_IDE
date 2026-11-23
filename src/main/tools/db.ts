/**
 * Database connections (IntelliJ "Database" tool window / DBeaver-lite).
 *
 * Drivers are pure JS (mysql2, pg, mssql/tedious, oracledb) and are loaded only when the
 * first connection of that kind is opened, so the IDE pays nothing until the user connects.
 *
 * Connection settings live in %APPDATA%/mixdog-ide/databases.json (shared by the dev build and
 * the installed app). Passwords are encrypted with Electron safeStorage (Windows DPAPI: only
 * this Windows user can decrypt them).
 *
 * Queries never pull a whole table into memory: every driver stops after `limit` rows
 * (cursor / maxRows / stream cancel) and reports whether there were more.
 */
import { app, safeStorage } from 'electron'
import { join, delimiter } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, readSync, closeSync, readdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { publish } from '../core/events'

export type DbKind = 'mysql' | 'mariadb' | 'postgres' | 'mssql' | 'oracle'

export interface DbConn {
  id: string
  name: string
  kind: DbKind
  host: string
  port: number
  /** MySQL: default schema (optional) · PostgreSQL / MSSQL: database · Oracle: service name or SID */
  database: string
  /** Oracle: `database` is a SID instead of a service name */
  sid?: boolean
  user: string
  savePassword: boolean
  /** only read statements (SELECT / SHOW / EXPLAIN ...) may run on this connection */
  readOnly: boolean
  /** MSSQL: encrypt the connection (Azure needs it; on-premise servers often have no valid cert) */
  encrypt?: boolean
}

export interface DbColumn {
  name: string
  type: string
  nullable: boolean
  pk: boolean
  comment: string
}

export interface DbObject {
  name: string
  type: 'table' | 'view'
  comment: string
}

export interface DbResult {
  columns: string[]
  rows: unknown[][]
  /** true when the query had more rows than `limit` */
  more: boolean
  /** rows changed by INSERT / UPDATE / DELETE (no result set) */
  affected: number | null
  ms: number
  /** manual-commit state of the connection after the statement */
  tx?: TxState
}

export interface TxState {
  /** manual commit mode (changes wait for commit / rollback) */
  manual: boolean
  /** uncommitted changes exist */
  pending: boolean
}

/** one data-changing statement of a grid save: '?' placeholders, values in order */
export interface DbStatement {
  sql: string
  params: unknown[]
  /** fail (and undo the save) unless exactly this many rows changed */
  expect?: number
}

interface FileShape {
  connections: DbConn[]
  /** encrypted passwords by connection id (base64) */
  secrets: Record<string, string>
  /** Oracle Client (Instant Client / XE bin) folder for thick mode; '' = auto-detect, null = never */
  oracleClient?: string | null
}

export const DEFAULT_PORT: Record<DbKind, number> = { mysql: 3306, mariadb: 3306, postgres: 5432, mssql: 1433, oracle: 1521 }

/* ------------------------------------------------------------------ storage */

const dir = (): string => join(app.getPath('appData'), 'mixdog-ide')
const file = (): string => join(dir(), 'databases.json')
/** query console files (IntelliJ keeps consoles outside the project too) */
export const consolesDir = (): string => join(dir(), 'consoles')

function load(): FileShape {
  try {
    const f = JSON.parse(readFileSync(file(), 'utf-8')) as FileShape
    f.connections ??= []
    f.secrets ??= {}
    return f
  } catch {
    return { connections: [], secrets: {} }
  }
}

function save(f: FileShape): void {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(file(), JSON.stringify(f, null, 2), 'utf-8')
}

const encrypt = (s: string): string =>
  safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s).toString('base64') : 'plain:' + Buffer.from(s).toString('base64')

function decrypt(s: string | undefined): string | null {
  if (!s) return null
  try {
    if (s.startsWith('plain:')) return Buffer.from(s.slice(6), 'base64').toString()
    return safeStorage.decryptString(Buffer.from(s, 'base64'))
  } catch {
    return null
  }
}

/** Connection list for the UI; `hasPassword` tells whether a password is stored. */
export function listConnections(): (DbConn & { hasPassword: boolean; connected: boolean })[] {
  const f = load()
  return f.connections.map((c) => ({ ...c, hasPassword: !!f.secrets[c.id], connected: sessions.has(c.id) }))
}

export function getConnection(id: string): DbConn {
  const c = load().connections.find((x) => x.id === id)
  if (!c) throw new Error('DB 연결을 찾을 수 없습니다')
  return c
}

/** Create or update. password: string = set, null = keep the stored one, '' with savePassword false = forget. */
export async function saveConnection(conn: DbConn, password: string | null): Promise<DbConn> {
  const f = load()
  const c: DbConn = { ...conn, id: conn.id || randomUUID(), name: conn.name.trim() || `${conn.kind}@${conn.host}`, port: Number(conn.port) || DEFAULT_PORT[conn.kind] }
  const i = f.connections.findIndex((x) => x.id === c.id)
  if (i >= 0) f.connections[i] = c
  else f.connections.push(c)
  if (!c.savePassword) delete f.secrets[c.id]
  else if (password !== null) f.secrets[c.id] = encrypt(password)
  save(f)
  // settings changed: the next query reconnects with them
  await disconnect(c.id)
  publish('db.connection.saved', { id: c.id, name: c.name, kind: c.kind, host: c.host })
  return c
}

export async function deleteConnection(id: string): Promise<void> {
  await disconnect(id)
  const f = load()
  f.connections = f.connections.filter((c) => c.id !== id)
  delete f.secrets[id]
  save(f)
}

const KIND_LABEL: Record<DbKind, string> = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', mssql: 'SQL Server', oracle: 'Oracle' }

/** The query console file of a connection (created on first use). */
export function consoleFile(id: string): string {
  const c = getConnection(id)
  const d = join(consolesDir(), id)
  mkdirSync(d, { recursive: true })
  // keep using an existing console even after the connection was renamed
  const existing = readdirSync(d).find((f) => f.toLowerCase().endsWith('.sql'))
  if (existing) return join(d, existing)
  const f = join(d, `${c.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'console'}.sql`)
  writeFileSync(
    f,
    `-- ${c.name} (${KIND_LABEL[c.kind]} ${c.user}@${c.host}) 쿼리 콘솔
-- Ctrl+Enter: 커서가 있는 문장 실행 · 선택 후 Ctrl+Enter: 선택 영역 실행

`,
    'utf-8'
  )
  return f
}

export function getOracleClient(): string | null {
  const v = load().oracleClient
  return v === undefined ? '' : v
}

export function setOracleClient(v: string | null): void {
  const f = load()
  f.oracleClient = v
  save(f)
}

/* ------------------------------------------------------------------ values */

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

function fmtDate(d: Date): string {
  if (isNaN(d.getTime())) return String(d)
  const ms = d.getMilliseconds()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms ? '.' + pad(ms, 3) : ''}`
}

/** Make a cell value IPC / JSON safe and readable. */
function cell(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return fmtDate(v)
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v)
    return `0x${b.subarray(0, 32).toString('hex').toUpperCase()}${b.length > 32 ? `… (${b.length} bytes)` : ''}`
  }
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/* ------------------------------------------------------------------ statements */

/** Strip leading comments / whitespace. */
function head(sql: string): string {
  let s = sql
  for (;;) {
    const t = s.trimStart()
    if (t.startsWith('--')) s = t.slice(t.indexOf('\n') + 1 || t.length)
    else if (t.startsWith('/*')) {
      const e = t.indexOf('*/')
      s = e < 0 ? '' : t.slice(e + 2)
    }
    else return t
  }
}

/** Remove string literals and comments, so keyword checks don't look inside them. */
const code = (sql: string): string =>
  sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')

/** data-changing words that can hide inside a SELECT / WITH (PostgreSQL data-modifying CTEs) */
const WRITE_WORDS = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke)\b/i

/** True for statements that only read (SELECT / WITH ... SELECT / SHOW / DESC / EXPLAIN). */
export function isReadOnly(sql: string): boolean {
  const c = code(head(sql)).trim().replace(/;\s*$/, '')
  const first = c.match(/^\(*\s*([a-z]+)/i)?.[1]?.toLowerCase() ?? ''
  if (['show', 'desc', 'describe', 'explain'].includes(first)) return true
  if (first !== 'select' && first !== 'with' && first !== 'values' && first !== 'table') return false
  // SELECT ... INTO / FOR UPDATE / data-changing CTEs
  if (/\binto\b/i.test(c) || /\bfor\s+update\b/i.test(c)) return false
  return !WRITE_WORDS.test(c)
}

/* ------------------------------------------------------------------ drivers */

interface Session {
  version: string
  /** current schema / database (what the tree expands first) */
  current: string
  query(sql: string, limit: number): Promise<Omit<DbResult, 'ms'>>
  /** small metadata query, all rows as objects */
  rows(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>
  /** data-changing statement with '?' binds; returns the rows changed */
  exec(sql: string, params: unknown[]): Promise<number>
  /** explicit transaction: statements after begin() wait for commit() / rollback() */
  begin(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  /** a transaction is open */
  inTx(): boolean
  /** the server ended the transaction by itself (DDL implicit commit) */
  endTx(): void
  close(): Promise<void>
}

/** Turn '?' placeholders (outside string literals) into the driver's style: $1 / @p1 / :1 */
function binds(sql: string, style: (n: number) => string): string {
  let n = 0
  let out = ''
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      const j = sql.indexOf("'", i + 1)
      const e = j < 0 ? sql.length : j
      out += sql.slice(i, e + 1)
      i = e
    } else if (ch === '?') out += style(++n)
    else out += ch
  }
  return out
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** CommonJS driver module, whichever way the bundler wrapped the dynamic import */
const cjs = (m: any): any => m?.default ?? m

async function mysqlSession(c: DbConn, password: string): Promise<Session> {
  const mysql = cjs(await import('mysql2'))
  const conn = mysql.createConnection({
    host: c.host,
    port: c.port,
    user: c.user,
    password,
    database: c.database || undefined,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',
    connectTimeout: 10000,
    multipleStatements: false
  })
  await new Promise<void>((res, rej) => conn.connect((e: unknown) => (e ? rej(e) : res())))
  const p = conn.promise()
  const all = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    const [r] = await p.query(sql, params)
    return r as Record<string, unknown>[]
  }
  const v = (await all('SELECT VERSION() AS v, DATABASE() AS d'))[0]
  let tx = false
  return {
    version: String(v.v),
    current: String(v.d ?? ''),
    rows: all,
    exec: async (sql, params) => ((await p.query(sql, params))[0] as any)?.affectedRows ?? 0,
    begin: async () => {
      await p.query('START TRANSACTION')
      tx = true
    },
    commit: async () => {
      await p.query('COMMIT')
      tx = false
    },
    rollback: async () => {
      await p.query('ROLLBACK')
      tx = false
    },
    inTx: () => tx,
    endTx: () => (tx = false),
    query: (sql, limit) =>
      new Promise((resolve, reject) => {
        let columns: string[] | null = null
        const rows: unknown[][] = []
        let more = false
        let affected: number | null = null
        const q = conn.query({ sql, rowsAsArray: true })
        q.on('error', reject)
        q.on('fields', (fields: any[]) => {
          // UPDATE / INSERT also emit 'fields' (undefined); a CALL can return several result sets: keep the first
          if (!columns && Array.isArray(fields) && fields.length) columns = fields.map((f) => f.name)
        })
        q.on('result', (r: any) => {
          // OK packet of INSERT / UPDATE / DELETE (or the status after a CALL)
          if (!Array.isArray(r)) {
            affected = (affected ?? 0) + (r?.affectedRows ?? 0)
            return
          }
          if (rows.length < limit) rows.push(r.map(cell))
          else more = true // past the limit the rest is read and dropped (memory stays flat)
        })
        q.on('end', () => resolve({ columns: columns ?? [], rows, more, affected: columns ? null : affected ?? 0 }))
      }),
    close: () => new Promise((res) => conn.end(() => res()))
  }
}

async function postgresSession(c: DbConn, password: string): Promise<Session> {
  const pg = cjs(await import('pg'))
  const Cursor = cjs(await import('pg-cursor'))
  // keep dates / timestamps exactly as the server prints them (no timezone shifts)
  for (const oid of [1082, 1083, 1114, 1184, 1266]) pg.types.setTypeParser(oid, (s: string) => s)
  pg.types.setTypeParser(20, (s: string) => s) // int8: keep precision
  pg.types.setTypeParser(1700, (s: string) => s) // numeric
  const client = new pg.Client({ host: c.host, port: c.port, user: c.user, password, database: c.database || 'postgres', connectionTimeoutMillis: 10000 })
  await client.connect()
  const all = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => (await client.query(sql, params)).rows
  const v = (await all('SELECT version() AS v, current_schema() AS s'))[0]
  let tx = false
  return {
    version: String(v.v).split(' on ')[0],
    current: String(v.s ?? 'public'),
    rows: all,
    exec: async (sql, params) => (await client.query(binds(sql, (n) => `$${n}`), params)).rowCount ?? 0,
    begin: async () => {
      await client.query('BEGIN')
      tx = true
    },
    commit: async () => {
      await client.query('COMMIT')
      tx = false
    },
    rollback: async () => {
      await client.query('ROLLBACK')
      tx = false
    },
    inTx: () => tx,
    endTx: () => (tx = false),
    query: async (sql, limit) => {
      const cur = client.query(new Cursor(sql, [], { rowMode: 'array' }))
      try {
        const got: unknown[][] = await cur.read(limit + 1)
        const res = (cur as any)._result
        const fields: any[] = res?.fields ?? []
        if (!fields.length) return { columns: [], rows: [], more: false, affected: res?.rowCount ?? 0 }
        return { columns: fields.map((f) => f.name), rows: got.slice(0, limit).map((r) => r.map(cell)), more: got.length > limit, affected: null }
      } finally {
        await cur.close().catch(() => {})
      }
    },
    close: () => client.end()
  }
}

async function mssqlSession(c: DbConn, password: string): Promise<Session> {
  const sql = cjs(await import('mssql'))
  const pool = new sql.ConnectionPool({
    server: c.host,
    port: c.port,
    user: c.user,
    password,
    database: c.database || undefined,
    connectionTimeout: 10000,
    requestTimeout: 0,
    pool: { max: 1, min: 0 },
    options: { encrypt: !!c.encrypt, trustServerCertificate: true, useUTC: false, enableArithAbort: true }
  })
  await pool.connect()
  // pool of one: while a transaction holds the connection every request must go through it
  let tx: any = null
  const req = (): any => (tx ? new sql.Request(tx) : pool.request())
  const all = async (q: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    const r = req()
    params.forEach((p, i) => r.input(`p${i + 1}`, p))
    return (await r.query(q)).recordset ?? []
  }
  const v = (await all('SELECT @@VERSION AS v, SCHEMA_NAME() AS s, DB_NAME() AS d'))[0]
  return {
    version: String(v.v).split('\n')[0].trim(),
    current: String(v.s ?? 'dbo'),
    rows: all,
    exec: async (q, params) => {
      const r = req()
      params.forEach((p, i) => r.input(`p${i + 1}`, p))
      const res = await r.query(binds(q, (n) => `@p${n}`))
      return (res.rowsAffected ?? []).reduce((a: number, b: number) => a + b, 0)
    },
    begin: async () => {
      const t = new sql.Transaction(pool)
      await t.begin()
      // the server aborted it (e.g. a deadlock or XACT_ABORT error)
      t.on('rollback', () => {
        if (tx === t) tx = null
      })
      tx = t
    },
    commit: async () => {
      const t = tx
      tx = null
      if (t) await t.commit()
    },
    rollback: async () => {
      const t = tx
      tx = null
      if (t) await t.rollback()
    },
    inTx: () => !!tx,
    endTx: () => {},
    query: (q, limit) =>
      new Promise((resolve, reject) => {
        const r: any = req()
        r.stream = true
        r.arrayRowMode = true
        let columns: string[] | null = null
        const rows: unknown[][] = []
        let more = false
        let affected: number | null = null
        let stopped = false
        r.on('recordset', (cols: any) => {
          if (columns) return
          const list: any[] = Array.isArray(cols) ? cols : Object.values(cols).sort((a: any, b: any) => a.index - b.index)
          columns = list.map((x) => x.name)
        })
        r.on('row', (row: unknown[]) => {
          if (stopped) return
          if (rows.length < limit) rows.push(row.map(cell))
          else {
            more = true
            stopped = true
            r.cancel()
          }
        })
        r.on('rowsaffected', (n: number) => (affected = (affected ?? 0) + n))
        const finish = (): void => resolve({ columns: columns ?? [], rows, more, affected: columns ? null : affected ?? 0 })
        r.on('error', (e: any) => (stopped && e?.code === 'ECANCEL' ? finish() : reject(e)))
        r.on('done', finish)
        r.query(q)
      }),
    close: () => pool.close()
  }
}

/** Oracle Client folder for thick mode: setting, or an oci.dll (64-bit) on PATH (Oracle XE / Instant Client). */
function oracleClientDir(): string | null {
  const set = getOracleClient()
  if (set === null) return null
  if (set) return existsSync(join(set, 'oci.dll')) ? set : null
  for (const p of (process.env.PATH ?? '').split(delimiter)) {
    const dll = join(p, 'oci.dll')
    if (p && existsSync(dll) && is64bit(dll)) return p
  }
  return null
}

function is64bit(dll: string): boolean {
  try {
    const fd = openSync(dll, 'r')
    const b = Buffer.alloc(1024)
    readSync(fd, b, 0, 1024, 0)
    closeSync(fd)
    const pe = b.readUInt32LE(0x3c)
    return b.readUInt16LE(pe + 4) === 0x8664
  } catch {
    return false
  }
}

let oracleMode: 'thin' | 'thick' | null = null
/** why thick mode could not start (e.g. the Oracle Client found is too old) */
let thickError = ''

async function oracleSession(c: DbConn, password: string): Promise<Session> {
  // @ts-ignore oracledb ships no type declarations
  const oracledb = cjs(await import('oracledb'))
  if (!oracleMode) {
    // Thick mode (needs an Oracle Client) also reaches 11g and older; thin mode needs 12.1+.
    // The mode is fixed for the whole process once the first connection is made.
    const lib = oracleClientDir()
    if (lib) {
      try {
        oracledb.initOracleClient({ libDir: lib })
        oracleMode = 'thick'
      } catch (e) {
        thickError = `${lib}: ${(e as Error)?.message ?? e}`
        publish('db.oracle.client', { libDir: lib, error: String(e) })
      }
    }
    oracleMode ??= 'thin'
  }
  oracledb.fetchAsString = [oracledb.CLOB, oracledb.NUMBER]
  oracledb.fetchAsBuffer = [oracledb.BLOB]
  const connectString = c.sid
    ? `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${c.host})(PORT=${c.port}))(CONNECT_DATA=(SID=${c.database})))`
    : `${c.host}:${c.port}/${c.database}`
  let conn: any
  try {
    conn = await oracledb.getConnection({ user: c.user, password, connectString })
  } catch (e: any) {
    if (String(e?.message).includes('NJS-138'))
      throw new Error(
        'Oracle 11g 서버는 Oracle Instant Client 19c (64bit) 가 필요합니다. 압축을 풀고 DB 연결 설정에서 Oracle Client 폴더로 지정한 뒤 IDE 를 다시 시작하세요.' +
          (thickError ? `
(찾은 클라이언트를 쓸 수 없음: ${thickError})` : '')
      )
    throw e
  }
  const all = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> =>
    (await conn.execute(sql, params, { outFormat: oracledb.OUT_FORMAT_OBJECT })).rows ?? []
  const v = (await all(`SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS S FROM DUAL`))[0]
  // Oracle has no BEGIN: a transaction is simply "don't auto-commit until commit() / rollback()"
  let tx = false
  return {
    version: `${conn.oracleServerVersionString ?? ''} (${oracleMode})`,
    current: String(v.S ?? c.user.toUpperCase()),
    rows: all,
    exec: async (sql, params) => (await conn.execute(binds(sql, (n) => `:${n}`), params, { autoCommit: !tx })).rowsAffected ?? 0,
    begin: async () => {
      tx = true
    },
    commit: async () => {
      await conn.commit()
      tx = false
    },
    rollback: async () => {
      await conn.rollback()
      tx = false
    },
    inTx: () => tx,
    endTx: () => (tx = false),
    query: async (sql, limit) => {
      // SQL statements must not end with ';' in Oracle; PL/SQL blocks must (END;)
      const plsql = /^(begin|declare|create\s+(or\s+replace\s+)?(procedure|function|package|trigger|type))\b/i.test(code(head(sql)).trim())
      const text = plsql ? sql.trim().replace(/\/\s*$/, '') : sql.trim().replace(/;\s*$/, '')
      const r = await conn.execute(text, [], { maxRows: limit + 1, outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit: !tx })
      if (!r.metaData) return { columns: [], rows: [], more: false, affected: r.rowsAffected ?? 0 }
      const rows = (r.rows ?? []) as unknown[][]
      return { columns: r.metaData.map((m: any) => m.name), rows: rows.slice(0, limit).map((x) => x.map(cell)), more: rows.length > limit, affected: null }
    },
    close: () => conn.close()
  }
}

const OPEN: Record<DbKind, (c: DbConn, pw: string) => Promise<Session>> = {
  mysql: mysqlSession,
  mariadb: mysqlSession,
  postgres: postgresSession,
  mssql: mssqlSession,
  oracle: oracleSession
}

/* ------------------------------------------------------------------ sessions */

const sessions = new Map<string, Promise<Session>>()
/** one statement at a time per connection */
const queues = new Map<string, Promise<unknown>>()
/** connections in manual commit mode (kept across reconnects for this run of the IDE) */
const manual = new Set<string>()
/** connections with uncommitted changes */
const pending = new Set<string>()

export const txState = (id: string): TxState => ({ manual: manual.has(id), pending: pending.has(id) })

/** statements that make MySQL / Oracle commit on their own */
const IMPLICIT_COMMIT = /^\s*(create|alter|drop|rename|truncate|grant|revoke|comment)\b/i

function passwordOf(id: string, given?: string | null): string {
  if (given != null) return given
  const pw = decrypt(load().secrets[id])
  if (pw === null) throw new Error('NEED_PASSWORD')
  return pw
}

async function session(id: string, password?: string | null): Promise<Session> {
  let s = sessions.get(id)
  if (!s) {
    const c = getConnection(id)
    s = OPEN[c.kind](c, passwordOf(id, password))
    sessions.set(id, s)
    s.then(
      (x) => publish('db.connect', { id, name: c.name, kind: c.kind, version: x.version }),
      () => sessions.delete(id)
    )
  }
  return s
}

function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(id) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(
    id,
    next.catch(() => {})
  )
  return next
}

/** Open the connection (password: only when not stored). Returns server version and current schema. */
export async function connect(id: string, password?: string | null): Promise<{ version: string; current: string }> {
  const s = await session(id, password)
  return { version: s.version, current: s.current }
}

/** Try settings without saving them. */
export async function testConnection(conn: DbConn, password: string | null): Promise<string> {
  const pw = password ?? (conn.id ? decrypt(load().secrets[conn.id]) : null) ?? ''
  const s = await OPEN[conn.kind]({ ...conn, port: Number(conn.port) || DEFAULT_PORT[conn.kind] }, pw)
  const v = s.version
  await s.close().catch(() => {})
  return v
}

/** Close the connection (also the way to stop a running query: the driver aborts it). */
export async function disconnect(id: string): Promise<void> {
  const s = sessions.get(id)
  sessions.delete(id)
  queues.delete(id)
  // closing without commit: every server rolls back the open transaction
  if (pending.delete(id)) publish('db.rollback', { id, reason: 'disconnect' })
  if (s) await s.then((x) => x.close()).catch(() => {})
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map(disconnect))
}

export async function runQuery(id: string, sql: string, opts: { limit?: number; source?: string; readOnly?: boolean; password?: string | null } = {}): Promise<DbResult> {
  const c = getConnection(id)
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 100000))
  if ((c.readOnly || opts.readOnly) && !isReadOnly(sql))
    throw new Error(c.readOnly ? `'${c.name}' 은(는) 읽기 전용 연결입니다. 조회(SELECT) 문만 실행할 수 있습니다.` : '조회(SELECT) 문만 실행할 수 있습니다.')
  const s = await session(id, opts.password)
  const t0 = Date.now()
  // COMMIT / ROLLBACK typed in the console: same as the toolbar buttons (keeps the pending state right)
  const word = code(head(sql)).trim().replace(/;\s*$/, '').toLowerCase().replace(/\s+/g, ' ')
  if (/^(commit|rollback)( work| transaction| tran)?$/.test(word)) {
    const tx = word.startsWith('commit') ? await commit(id) : await rollback(id)
    publish('db.query', { connection: c.name, sql, rows: 0, ms: Date.now() - t0 }, opts.source ?? 'user')
    return { columns: [], rows: [], more: false, affected: 0, ms: Date.now() - t0, tx }
  }
  try {
    const r = await serial(id, async () => {
      // manual commit: every statement runs inside a transaction that waits for commit / rollback
      if (manual.has(id) && !s.inTx()) await s.begin()
      const out = await s.query(sql, limit)
      if (manual.has(id)) {
        if (c.kind !== 'postgres' && c.kind !== 'mssql' && IMPLICIT_COMMIT.test(head(sql))) {
          // DDL committed everything so far
          s.endTx()
          pending.delete(id)
        } else if (!isReadOnly(sql)) pending.add(id)
      }
      return out
    })
    const res = { ...r, ms: Date.now() - t0, tx: txState(id) }
    publish(
      'db.query',
      { connection: c.name, sql: sql.slice(0, 500), rows: res.rows.length, more: res.more, affected: res.affected, ms: res.ms },
      opts.source ?? 'user'
    )
    return res
  } catch (e) {
    publish('db.query', { connection: c.name, sql: sql.slice(0, 500), error: String((e as Error)?.message ?? e) }, opts.source ?? 'user')
    // a dropped / killed connection: next query reconnects
    if (/ECONNRESET|closed|ETIMEDOUT|EPIPE|Connection lost|not connected|NJS-003|NJS-500|DPI-1080/i.test(String((e as Error)?.message))) void disconnect(id)
    // PostgreSQL: after an error the open transaction accepts nothing until it is rolled back
    if (c.kind === 'postgres' && manual.has(id) && /current transaction is aborted/i.test(String((e as Error)?.message)))
      throw new Error(`${(e as Error).message}\n→ 앞의 오류로 트랜잭션이 중단됐습니다. [롤백] 후 다시 실행하세요.`)
    throw e
  }
}

/** Manual / auto commit. Switching to auto commits what is pending (IntelliJ does the same). */
export async function setManualCommit(id: string, on: boolean): Promise<TxState> {
  if (on) manual.add(id)
  else {
    manual.delete(id)
    const s = sessions.get(id)
    if (s) {
      const x = await s
      if (x.inTx()) await serial(id, () => x.commit())
    }
    if (pending.delete(id)) publish('db.commit', { id, reason: 'auto-commit on' })
  }
  return txState(id)
}

export async function commit(id: string): Promise<TxState> {
  const s = sessions.get(id)
  if (s) {
    const x = await s
    if (x.inTx()) await serial(id, () => x.commit())
  }
  if (pending.delete(id)) publish('db.commit', { id, connection: getConnection(id).name })
  return txState(id)
}

export async function rollback(id: string): Promise<TxState> {
  const s = sessions.get(id)
  if (s) {
    const x = await s
    if (x.inTx()) await serial(id, () => x.rollback())
  }
  if (pending.delete(id)) publish('db.rollback', { id, connection: getConnection(id).name })
  return txState(id)
}

const SAVEPOINT: Record<DbKind, [string, string]> = {
  mysql: ['SAVEPOINT mixdog_save', 'ROLLBACK TO SAVEPOINT mixdog_save'],
  mariadb: ['SAVEPOINT mixdog_save', 'ROLLBACK TO SAVEPOINT mixdog_save'],
  postgres: ['SAVEPOINT mixdog_save', 'ROLLBACK TO SAVEPOINT mixdog_save'],
  oracle: ['SAVEPOINT mixdog_save', 'ROLLBACK TO SAVEPOINT mixdog_save'],
  mssql: ['SAVE TRANSACTION mixdog_save', 'ROLLBACK TRANSACTION mixdog_save']
}

/**
 * Save edits of the result grid: all statements succeed or none does.
 * Auto commit: one transaction, committed at the end. Manual commit: inside the open transaction
 * (a savepoint undoes a failed save), committed later by the user.
 */
export async function saveChanges(id: string, statements: DbStatement[], password?: string | null): Promise<{ affected: number; tx: TxState }> {
  const c = getConnection(id)
  if (c.readOnly) throw new Error(`'${c.name}' 은(는) 읽기 전용 연결입니다.`)
  const s = await session(id, password)
  const isManual = manual.has(id)
  let affected = 0
  await serial(id, async () => {
    if (!s.inTx()) await s.begin()
    if (isManual) await s.exec(SAVEPOINT[c.kind][0], [])
    try {
      for (const st of statements) {
        const n = await s.exec(st.sql, st.params)
        if (st.expect !== undefined && n !== st.expect)
          throw new Error(
            n === 0
              ? `바꿀 행을 찾지 못했습니다 (다른 곳에서 바뀌었거나 지워졌을 수 있습니다). 다시 조회한 뒤 수정하세요.\n${st.sql}`
              : `${n}개 행이 함께 바뀌어 저장을 취소했습니다 (PK 가 유일하지 않음).\n${st.sql}`
          )
        affected += n
      }
    } catch (e) {
      if (isManual) await s.exec(SAVEPOINT[c.kind][1], []).catch(() => {})
      else await s.rollback().catch(() => {})
      throw e
    }
    if (isManual) pending.add(id)
    else await s.commit()
  })
  publish('db.save', { connection: c.name, statements: statements.length, affected, manual: isManual })
  return { affected, tx: txState(id) }
}

/* ------------------------------------------------------------------ metadata */

export async function listSchemas(id: string): Promise<{ schemas: string[]; current: string }> {
  const c = getConnection(id)
  const s = await session(id)
  const q: Record<DbKind, string> = {
    mysql: `SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','mysql','sys') ORDER BY 1`,
    mariadb: '',
    postgres: `SELECT schema_name AS n FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema' ORDER BY 1`,
    mssql: `SELECT s.name AS n FROM sys.schemas s WHERE EXISTS (SELECT 1 FROM sys.objects o WHERE o.schema_id = s.schema_id AND o.type IN ('U','V')) OR s.name = SCHEMA_NAME() ORDER BY 1`,
    oracle: `SELECT username AS N FROM all_users u WHERE oracle_maintained = 'N' OR username = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') ORDER BY 1`
  }
  q.mariadb = q.mysql
  let rows: Record<string, unknown>[]
  try {
    rows = await serial(id, () => s.rows(q[c.kind], []))
  } catch (e) {
    // Oracle 11g has no ORACLE_MAINTAINED column: schemas that own tables or views
    if (c.kind !== 'oracle') throw e
    rows = await serial(id, () =>
      s.rows(`SELECT DISTINCT owner AS N FROM all_objects WHERE object_type IN ('TABLE','VIEW') AND owner NOT IN ('SYS','SYSTEM','XDB','MDSYS','CTXSYS','OUTLN','DBSNMP','APEX_040000','FLOWS_FILES','ANONYMOUS','APPQOSSYS','ORDSYS','ORDDATA','WMSYS','EXFSYS','OLAPSYS') ORDER BY 1`, [])
    )
  }
  const schemas = rows.map((r) => String(r.n ?? r.N))
  if (s.current && !schemas.includes(s.current)) schemas.unshift(s.current)
  return { schemas, current: s.current }
}

export async function listObjects(id: string, schema: string): Promise<DbObject[]> {
  const c = getConnection(id)
  const s = await session(id)
  const q: Record<DbKind, string> = {
    mysql: `SELECT TABLE_NAME AS n, TABLE_TYPE AS t, TABLE_COMMENT AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY 1`,
    mariadb: '',
    postgres: `SELECT t.table_name AS n, t.table_type AS t, obj_description(format('%I.%I', t.table_schema, t.table_name)::regclass) AS c FROM information_schema.tables t WHERE t.table_schema = $1 ORDER BY 1`,
    mssql: `SELECT o.name AS n, CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'TABLE' END AS t, CAST(ep.value AS nvarchar(4000)) AS c FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description' WHERE o.type IN ('U','V') AND s.name = @p1 ORDER BY 1`,
    oracle: `SELECT o.object_name AS N, o.object_type AS T, c.comments AS C FROM all_objects o LEFT JOIN all_tab_comments c ON c.owner = o.owner AND c.table_name = o.object_name WHERE o.owner = :1 AND o.object_type IN ('TABLE','VIEW') ORDER BY 1`
  }
  q.mariadb = q.mysql
  const rows = await serial(id, () => s.rows(q[c.kind], [schema]))
  return rows.map((r) => ({
    name: String(r.n ?? r.N),
    type: /view/i.test(String(r.t ?? r.T)) ? 'view' : 'table',
    // MySQL fills the comment of a view with the word VIEW
    comment: String(r.c ?? r.C ?? '').replace(/^VIEW$/, '')
  }))
}

export async function listColumns(id: string, schema: string, table: string): Promise<DbColumn[]> {
  const c = getConnection(id)
  const s = await session(id)
  const q: Record<DbKind, string> = {
    mysql: `SELECT COLUMN_NAME AS n, COLUMN_TYPE AS t, IS_NULLABLE AS nl, COLUMN_KEY = 'PRI' AS pk, COLUMN_COMMENT AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    mariadb: '',
    postgres: `SELECT a.attname AS n, format_type(a.atttypid, a.atttypmod) AS t, CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nl,
      EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk,
      col_description(a.attrelid, a.attnum) AS c
      FROM pg_attribute a WHERE a.attrelid = format('%I.%I', $1::text, $2::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    mssql: `SELECT c.name AS n, TYPE_NAME(c.user_type_id) + CASE WHEN TYPE_NAME(c.user_type_id) IN ('varchar','char','varbinary','binary') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar) END + ')' WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar','nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar) END + ')' WHEN TYPE_NAME(c.user_type_id) IN ('decimal','numeric') THEN '(' + CAST(c.precision AS varchar) + ',' + CAST(c.scale AS varchar) + ')' ELSE '' END AS t,
      CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS nl,
      CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk,
      CAST(ep.value AS nvarchar(4000)) AS c
      FROM sys.columns c LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
      WHERE c.object_id = OBJECT_ID(QUOTENAME(@p1) + '.' + QUOTENAME(@p2)) ORDER BY c.column_id`,
    oracle: `SELECT c.column_name AS N,
      c.data_type || CASE WHEN c.data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR','RAW') THEN '(' || c.char_length || ')' WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL THEN '(' || c.data_precision || ',' || c.data_scale || ')' ELSE '' END AS T,
      CASE c.nullable WHEN 'Y' THEN 'YES' ELSE 'NO' END AS NL,
      (SELECT COUNT(*) FROM all_constraints k JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name WHERE k.owner = c.owner AND k.table_name = c.table_name AND k.constraint_type = 'P' AND kc.column_name = c.column_name) AS PK,
      m.comments AS C
      FROM all_tab_columns c LEFT JOIN all_col_comments m ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name
      WHERE c.owner = :1 AND c.table_name = :2 ORDER BY c.column_id`
  }
  q.mariadb = q.mysql
  const rows = await serial(id, () => s.rows(q[c.kind], [schema, table]))
  return rows.map((r) => ({
    name: String(r.n ?? r.N),
    type: String(r.t ?? r.T ?? ''),
    nullable: String(r.nl ?? r.NL) === 'YES',
    pk: Number(r.pk ?? r.PK) > 0 || r.pk === true,
    comment: String(r.c ?? r.C ?? '')
  }))
}

/** Identifier quoting per dialect (for generated SELECTs). */
export function quoteIdent(kind: DbKind, name: string): string {
  if (kind === 'mysql' || kind === 'mariadb') return '`' + name.replace(/`/g, '``') + '`'
  if (kind === 'mssql') return '[' + name.replace(/]/g, ']]') + ']'
  // Oracle / PostgreSQL: quote only when needed, so ordinary names stay readable
  const plain = kind === 'oracle' ? /^[A-Z][A-Z0-9_$#]*$/ : /^[a-z_][a-z0-9_$]*$/
  return plain.test(name) ? name : '"' + name.replace(/"/g, '""') + '"'
}
