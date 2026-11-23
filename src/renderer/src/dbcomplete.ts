/**
 * SQL completion for .sql editors attached to a DB connection (IntelliJ style):
 * keywords, schemas, tables / views (with comments) and columns of the tables the statement uses,
 * including `alias.` → that table's columns. Metadata comes from the Database tree cache, so the
 * DB is asked only once per schema / table.
 */
import { monaco, docs } from './monaco'
import type { languages, editor, IRange } from 'monaco-editor'
import { connIdOf, connOf, connectQuietly, schemasOf, objectsOf, columnsOf, statementAt, type DbKind, type DbObject } from './db'
import { tableRefs, unquote, sqlName, blankLiterals, type TableRef } from './dbsql'

const KEYWORDS = `SELECT FROM WHERE AND OR NOT IN IS NULL LIKE BETWEEN EXISTS JOIN LEFT RIGHT INNER OUTER FULL CROSS ON USING
GROUP BY ORDER HAVING ASC DESC DISTINCT AS CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE UNION ALL
COUNT SUM AVG MIN MAX COALESCE CAST CREATE TABLE VIEW INDEX ALTER DROP ADD COLUMN PRIMARY KEY FOREIGN REFERENCES
DEFAULT CONSTRAINT UNIQUE COMMIT ROLLBACK TRUNCATE WITH OVER PARTITION ROW_NUMBER UPPER LOWER TRIM SUBSTR REPLACE`.split(/\s+/)

const DIALECT: Record<DbKind, string[]> = {
  oracle: 'NVL NVL2 DECODE ROWNUM ROWID SYSDATE SYSTIMESTAMP DUAL TO_CHAR TO_DATE TO_NUMBER TRUNC FETCH FIRST ROWS ONLY MINUS MERGE CONNECT PRIOR LISTAGG'.split(' '),
  mysql: 'LIMIT OFFSET IFNULL NOW CURDATE DATE_FORMAT CONCAT GROUP_CONCAT AUTO_INCREMENT SHOW DESCRIBE STR_TO_DATE'.split(' '),
  mariadb: [],
  mssql: 'TOP ISNULL GETDATE CONVERT LEN DATEADD DATEDIFF OFFSET FETCH NEXT ROWS ONLY NOLOCK IDENTITY'.split(' '),
  postgres: 'LIMIT OFFSET ILIKE NOW CURRENT_DATE TO_CHAR STRING_AGG RETURNING SERIAL ON CONFLICT DO NOTHING'.split(' ')
}
DIALECT.mariadb = DIALECT.mysql

/** keywords after which a table name is expected */
const TABLE_CTX = /^(from|join|update|into|table|describe|desc)$/i

function pathOf(model: editor.ITextModel): string | null {
  for (const [p, d] of docs) if (d.model === model) return p
  return null
}

/** Find a table of the statement in the metadata (names are matched case-insensitively). */
async function resolve(id: string, current: string, ref: TableRef): Promise<{ schema: string; obj: DbObject } | null> {
  const schema = ref.schema ?? current
  try {
    const { schemas } = await schemasOf(id)
    const s = schemas.find((x) => x.toLowerCase() === schema.toLowerCase()) ?? schema
    const obj = (await objectsOf(id, s)).find((o) => o.name.toLowerCase() === ref.name.toLowerCase())
    return obj ? { schema: s, obj } : null
  } catch {
    return null
  }
}

let registered = false

export function registerSqlCompletion(): void {
  if (registered) return
  registered = true
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.'],
    provideCompletionItems: async (model, pos) => {
      const path = pathOf(model)
      const id = path ? connIdOf(path) : null
      const c = id ? connOf(id) : undefined
      const word = model.getWordUntilPosition(pos)
      const range: IRange = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
      const lower = word.word.length > 0 && word.word === word.word.toLowerCase()
      const kw = (k: string): string => (lower ? k.toLowerCase() : k)
      const K = monaco.languages.CompletionItemKind
      const items: languages.CompletionItem[] = []

      const src = model.getValue()
      const offset = model.getOffsetAt(pos)
      const st = statementAt(src, offset)
      const inStmt = st && offset >= st.start && offset <= st.end + 1
      const stmt = inStmt ? st.text : ''
      const before = inStmt ? src.slice(st.start, offset - word.word.length) : ''
      const bare = blankLiterals(before)
      // inside a string literal or comment: nothing
      if (inStmt && bare.length && bare.slice(-1) === ' ' && before.slice(-1) !== ' ') return { suggestions: [] }

      const qual = before.match(/((?:[\w$#À-￿]+|"[^"]+"|`[^`]+`|\[[^\]]+\]))\s*\.\s*$/)?.[1]
      const lastKw = bare.match(/\b([a-z_]+)\b[^a-z_]*$/i)?.[1] ?? ''
      // after "FROM a," the next name is a table as well
      const tableCtx = TABLE_CTX.test(lastKw) || /\bfrom\b[^;()]*,\s*$/i.test(bare) && !/\b(where|on|set|group|order)\b[^;]*$/i.test(bare.slice(bare.search(/\bfrom\b[^;]*$/i)))

      const ready = !!(c && id && (await connectQuietly(id)))
      let current = ''
      if (ready) {
        try {
          current = (await schemasOf(id!)).current
        } catch {
          /* metadata not available: keywords only */
        }
      }
      const kind = c?.kind ?? 'mysql'

      const tableItem = (o: DbObject, schema: string | null, sort: string): languages.CompletionItem => ({
        label: { label: o.name, description: o.comment || (o.type === 'view' ? '뷰' : '') },
        kind: o.type === 'view' ? K.Interface : K.Class,
        insertText: (schema ? sqlName(kind, schema) + '.' : '') + sqlName(kind, o.name),
        filterText: o.name,
        detail: o.type === 'view' ? '뷰' : '테이블',
        documentation: o.comment || undefined,
        sortText: sort + o.name.toLowerCase(),
        range
      })

      const columnItems = async (ref: TableRef, sort: string): Promise<void> => {
        const t = await resolve(id!, current, ref)
        if (!t) return
        const cols = await columnsOf(id!, t.schema, t.obj.name).catch(() => [])
        for (const col of cols) {
          items.push({
            label: { label: col.name, detail: ` ${col.type.toLowerCase()}${col.pk ? ' PK' : ''}`, description: col.comment || t.obj.name },
            kind: col.pk ? K.Constant : K.Field,
            insertText: sqlName(kind, col.name),
            filterText: col.name,
            detail: `${t.obj.name}.${col.name} · ${col.type.toLowerCase()}`,
            documentation: col.comment || undefined,
            sortText: sort + col.name.toLowerCase(),
            range
          })
        }
      }

      if (qual) {
        // alias. / table. → columns · schema. → tables
        if (!ready) return { suggestions: [] }
        const q = unquote(qual).toLowerCase()
        const refs = tableRefs(stmt)
        const ref = refs.find((r) => r.alias?.toLowerCase() === q) ?? refs.find((r) => r.name.toLowerCase() === q)
        if (ref) await columnItems(ref, '0')
        else {
          const { schemas } = await schemasOf(id!).catch(() => ({ schemas: [] as string[] }))
          const s = schemas.find((x) => x.toLowerCase() === q)
          if (s) for (const o of await objectsOf(id!, s).catch(() => [])) items.push({ ...tableItem(o, null, '0') })
          else await columnItems({ schema: null, name: unquote(qual), alias: null }, '0')
        }
        return { suggestions: items }
      }

      if (ready && current) {
        const objs = await objectsOf(id!, current).catch(() => [] as DbObject[])
        if (tableCtx) {
          for (const o of objs) items.push(tableItem(o, null, '0'))
          const { schemas } = await schemasOf(id!).catch(() => ({ schemas: [] as string[] }))
          for (const s of schemas)
            if (s !== current) items.push({ label: s, kind: K.Module, insertText: sqlName(kind, s), detail: '스키마', sortText: '1' + s, range })
          return { suggestions: items }
        }
        for (const ref of tableRefs(stmt)) await columnItems(ref, '0')
        for (const o of objs) items.push(tableItem(o, null, '1'))
      }
      for (const k of [...KEYWORDS, ...(DIALECT[kind] ?? [])])
        items.push({ label: kw(k), kind: K.Keyword, insertText: kw(k), sortText: '2' + k.toLowerCase(), range })
      return { suggestions: items }
    }
  })
}
