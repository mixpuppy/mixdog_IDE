/**
 * SQL text helpers shared by completion, SQL generation and result editing:
 * finding the tables a statement uses, quoting names, and writing literals per dialect.
 */
import type { DbKind, DbColumn } from './db'

/** Replace string literals and comments with blanks of the same length (offsets stay valid). */
export function blankLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, (m) => m.replace(/[^\n]/g, ' '))
}

const IDENT = String.raw`(?:[A-Za-z_À-￿][\w$#À-￿]*|"[^"]+"|\`[^\`]+\`|\[[^\]]+\])`
const NAME = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`

/** words that end a table reference instead of being its alias */
const NOT_ALIAS = new Set(
  'where join left right inner outer full cross natural on using set values select order group having limit offset fetch union intersect except minus for with as window start connect pivot unpivot into returning lateral partition'.split(
    ' '
  )
)

export const unquote = (s: string): string => {
  const t = s.trim()
  if (/^(".*"|`.*`|\[.*\])$/s.test(t)) return t.slice(1, -1)
  return t
}

export interface TableRef {
  schema: string | null
  name: string
  alias: string | null
}

function parseName(raw: string): { schema: string | null; name: string } {
  const parts = raw.match(new RegExp(IDENT, 'g')) ?? [raw]
  return parts.length > 1 ? { schema: unquote(parts[0]), name: unquote(parts[1]) } : { schema: null, name: unquote(parts[0]) }
}

/** Tables a statement reads or writes (FROM a x, b / JOIN c / UPDATE d / INSERT INTO e / DELETE FROM f). */
export function tableRefs(sql: string): TableRef[] {
  const s = blankLiterals(sql)
  const out: TableRef[] = []
  const add = (raw: string, alias?: string): void => {
    const n = parseName(raw)
    if (!n.name || NOT_ALIAS.has(n.name.toLowerCase()) || n.name.toLowerCase() === 'select') return
    const a = alias && !NOT_ALIAS.has(alias.toLowerCase()) ? unquote(alias) : null
    out.push({ ...n, alias: a })
  }
  const one = new RegExp(`^\\s*(${NAME})(?:\\s+(?:as\\s+)?(${IDENT}))?`, 'i')
  // FROM list (comma separated) up to the next clause
  const fromRe = /\bfrom\b([\s\S]*?)(?=\b(?:where|join|left|right|inner|outer|full|cross|natural|group|order|having|limit|offset|fetch|union|intersect|except|minus|for|window|connect|start|returning)\b|\)|;|$)/gi
  for (const m of s.matchAll(fromRe)) {
    for (const part of m[1].split(',')) {
      const t = part.match(one)
      if (t) add(t[1], t[2])
    }
  }
  const kwRe = new RegExp(`\\b(?:join|update|into)\\s+(${NAME})(?:\\s+(?:as\\s+)?(${IDENT}))?`, 'gi')
  for (const m of s.matchAll(kwRe)) add(m[1], m[2])
  // keep the first occurrence of each table/alias
  const seen = new Set<string>()
  return out.filter((r) => {
    const k = `${r.schema ?? ''}.${r.name}.${r.alias ?? ''}`.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** The single table of a plain `SELECT ... FROM t [alias] [WHERE ...]` (no joins / grouping / unions), else null. */
export function singleTable(sql: string): TableRef | null {
  const s = blankLiterals(sql).trim().replace(/;\s*$/, '')
  if (!/^select\b/i.test(s)) return null
  if (/\b(join|group\s+by|having|union|intersect|except|minus|distinct|connect\s+by|pivot)\b/i.test(s)) return null
  // the FROM part must be one name (optionally aliased), no sub-query
  const m = s.match(new RegExp(`\\bfrom\\s+(${NAME})(?:\\s+(?:as\\s+)?(${IDENT}))?\\s*(?:$|where\\b|order\\b|limit\\b|offset\\b|fetch\\b|for\\b)`, 'i'))
  if (!m) return null
  // only one FROM (no sub-queries in the select list / where)
  if ((s.match(/\bfrom\b/gi) ?? []).length !== 1 || /\(\s*select\b/i.test(s)) return null
  const n = parseName(m[1])
  return { ...n, alias: m[2] && !NOT_ALIAS.has(m[2].toLowerCase()) ? unquote(m[2]) : null }
}

/* ---------------------------------------------------------------- names */

const RESERVED = new Set(
  'select from where and or not in is null like between exists join left right inner outer cross on group by order having asc desc distinct as case when then else end insert into values update set delete union all limit offset table user date level comment number size key index type'.split(
    ' '
  )
)

/** Name as typed in SQL: plain when the dialect allows it, quoted otherwise. */
export function sqlName(kind: DbKind, name: string): string {
  const plain =
    kind === 'oracle' ? /^[A-Z][A-Z0-9_$#]*$/ : kind === 'postgres' ? /^[a-z_][a-z0-9_$]*$/ : /^[A-Za-z_][A-Za-z0-9_$]*$/
  if (plain.test(name) && !RESERVED.has(name.toLowerCase())) return name
  if (kind === 'mysql' || kind === 'mariadb') return '`' + name.replace(/`/g, '``') + '`'
  if (kind === 'mssql') return '[' + name.replace(/]/g, ']]') + ']'
  return '"' + name.replace(/"/g, '""') + '"'
}

/* ---------------------------------------------------------------- values */

const isNumType = (t: string): boolean => /^(tiny|small|medium|big)?int|^integer|^number|^numeric|^decimal|^dec\b|^float|^double|^real|^money|^smallmoney|^bit\b|^serial|^bigserial|^smallserial/i.test(t)
export const isDateType = (t: string): boolean => /^(date|datetime|datetime2|smalldatetime|timestamp|time)\b/i.test(t)
export const isBinaryType = (t: string): boolean => /blob|binary|bytea|^raw|^long raw|^image|^bfile|^bit\b.*\(|^geometry|^geography/i.test(t)

/** SQL literal of a cell value (for copied INSERT / UPDATE statements and the save preview). */
export function literal(kind: DbKind, v: unknown, type = ''): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (typeof v === 'boolean') return kind === 'postgres' ? String(v) : v ? '1' : '0'
  const s = String(v)
  if (isBinaryType(type)) {
    // the grid shows binary as 0xHEX (cut after 32 bytes: then the real value is unknown)
    const hex = s.match(/^0x([0-9A-F]+)$/i)?.[1]
    if (!hex) return 'NULL /* 바이너리 값 생략 */'
    if (kind === 'oracle') return `HEXTORAW('${hex}')`
    if (kind === 'postgres') return `'\\x${hex}'::bytea`
    return `0x${hex}`
  }
  if (isNumType(type) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return s
  let q = "'" + s.replace(/'/g, "''") + "'"
  if (kind === 'mysql' || kind === 'mariadb') q = q.replace(/\\/g, '\\\\')
  if (kind === 'mssql' && /[^\x00-\x7f]/.test(s)) q = 'N' + q
  if (kind === 'oracle' && isDateType(type)) {
    return /^timestamp/i.test(type) ? `TO_TIMESTAMP(${q}, 'YYYY-MM-DD HH24:MI:SS.FF')` : `TO_DATE(${q}, 'YYYY-MM-DD HH24:MI:SS')`
  }
  return q
}

/** Bind placeholder for a column ('?' is turned into the driver's own style in the main process). */
export function placeholder(kind: DbKind, type = ''): string {
  if (kind === 'oracle' && isDateType(type)) return /^timestamp/i.test(type) ? `TO_TIMESTAMP(?, 'YYYY-MM-DD HH24:MI:SS.FF')` : `TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS')`
  return '?'
}

/* ---------------------------------------------------------------- generated statements */

export type GenKind = 'select' | 'insert' | 'update' | 'delete' | 'columns'

/** Template statements for a table (tree menu "SQL 생성"); '?' marks values to fill in. */
export function generate(what: GenKind, kind: DbKind, table: string, cols: DbColumn[]): string {
  const name = (c: DbColumn): string => sqlName(kind, c.name)
  const pk = cols.filter((c) => c.pk)
  const keys = pk.length ? pk : cols.slice(0, 1)
  const where = keys.map((c) => `${name(c)} = ?`).join('\n  AND ')
  const w = Math.max(...cols.map((c) => name(c).length), 4)
  const note = (c: DbColumn): string => {
    const bits = [c.type.toLowerCase() + (c.pk ? ' PK' : '') + (c.nullable ? '' : ' NOT NULL'), c.comment].filter(Boolean)
    return ` -- ${bits.join(' · ')}`
  }
  const list = (fmt: (c: DbColumn) => string): string =>
    cols.map((c, i) => `  ${fmt(c)}${i < cols.length - 1 ? ',' : ''}`.padEnd(w + 10) + note(c)).join('\n')
  switch (what) {
    case 'columns':
      return cols.map(name).join(', ')
    case 'select':
      return `SELECT\n${list(name)}\nFROM ${table}\nWHERE ${where}`
    case 'insert':
      return `INSERT INTO ${table} (\n${list(name)}\n) VALUES (\n${list((c) => `? /* ${c.name} */`)}\n)`
    case 'update': {
      const set = cols.filter((c) => !keys.includes(c))
      const lines = (set.length ? set : cols).map((c, i, a) => `  ${name(c)} = ?${i < a.length - 1 ? ',' : ''}`.padEnd(w + 14) + note(c)).join('\n')
      return `UPDATE ${table}\nSET\n${lines}\nWHERE ${where}`
    }
    case 'delete':
      return `DELETE FROM ${table}\nWHERE ${where}`
  }
}
