/**
 * Light "Go to declaration" (Ctrl+click / F12) without a language server: text rules that fit
 * Spring + MyBatis projects.
 *
 * Java:  Type → its file (import / same package / wildcard import / any file of that name)
 *        name( / obj.name( / Type.name / this.name → method or field in the owner class
 *        (owner = type of the variable / field / parameter), then its super types;
 *        a MyBatis mapper interface method also lists the <select|insert|update|delete id> of its XML.
 * XML:   id="..." of a mapper statement → the interface method; resultMap / refid → <resultMap> / <sql>;
 *        namespace / type / resultType / parameterType / any a.b.Class → the class.
 * Other files (JSP, properties...): a fully qualified class name → the class.
 *
 * Not exact like a compiler (overloads, generics, inherited fields of library classes), but it
 * never needs a background process.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { listFiles } from './search'

export interface Loc {
  path: string
  line: number
  col: number
}

const SRC_EXT = /\.(java|kt)$/i

/* ------------------------------------------------------------------ project index (cached briefly) */

interface Index {
  at: number
  /** simple class name (lower case) -> relative paths */
  byName: Map<string, string[]>
  xml: string[]
}
const indexes = new Map<string, Index>()

async function indexOf(project: string): Promise<Index> {
  const k = project.toLowerCase()
  const hit = indexes.get(k)
  if (hit && Date.now() - hit.at < 5000) return hit
  const files = await listFiles(project)
  const byName = new Map<string, string[]>()
  const xml: string[] = []
  for (const f of files) {
    if (SRC_EXT.test(f)) {
      const n = f.slice(f.lastIndexOf('/') + 1).replace(SRC_EXT, '').toLowerCase()
      byName.set(n, [...(byName.get(n) ?? []), f])
    } else if (/\.xml$/i.test(f) && !/(^|\/)(pom|web|build|checkstyle|logback|log4j2?)\.xml$/i.test(f)) xml.push(f)
  }
  const ix = { at: Date.now(), byName, xml }
  indexes.set(k, ix)
  return ix
}

const texts = new Map<string, { at: number; text: string }>()
async function read(path: string): Promise<string> {
  const k = path.toLowerCase()
  const hit = texts.get(k)
  if (hit && Date.now() - hit.at < 3000) return hit.text
  let text = ''
  try {
    text = await fs.readFile(path, 'utf-8')
  } catch {
    /* gone */
  }
  texts.set(k, { at: Date.now(), text })
  if (texts.size > 400) texts.clear()
  return text
}

/** MyBatis mapper XMLs by namespace (lower case) */
async function mappers(project: string): Promise<Map<string, string[]>> {
  const ix = await indexOf(project)
  const out = new Map<string, string[]>()
  await Promise.all(
    ix.xml.map(async (rel) => {
      const full = join(project, rel)
      const t = await read(full)
      const ns = t.match(/<mapper\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/)?.[1]
      if (ns) out.set(ns.toLowerCase(), [...(out.get(ns.toLowerCase()) ?? []), full])
    })
  )
  return out
}

/* ------------------------------------------------------------------ text helpers */

function posOf(text: string, index: number): { line: number; col: number } {
  let line = 1
  let last = -1
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) {
    line++
    last = i
  }
  return { line, col: index - last }
}

/** blank out comments and string literals (same length) so declarations inside them don't match */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => m.replace(/[^\n]/g, ' '))
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&')

const KEYWORDS = new Set('return new throw else case if while for switch catch synchronized assert yield do try instanceof'.split(' '))

/** `raw`: search the text as is (XML: attribute values are in quotes, `code()` would blank them) */
function locIn(path: string, text: string, re: RegExp, group = 1, raw = false): Loc[] {
  const out: Loc[] = []
  const c = raw ? text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')) : code(text)
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(c))) {
    const at = m.index + m[0].lastIndexOf(m[group])
    out.push({ path, ...posOf(text, at) })
    if (!re.global) break
  }
  return out
}

/* ------------------------------------------------------------------ Java types */

const packageOf = (src: string): string => src.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? ''

function typeDecl(path: string, text: string, name: string): Loc[] {
  const l = locIn(path, text, new RegExp(`\\b(?:class|interface|enum|record|@interface|object)\\s+(${esc(name)})\\b`))
  return l.length ? l : [{ path, line: 1, col: 1 }]
}

/** files that may hold type `name`, best guess first, as seen from `fromPath` / `fromText` */
async function typeFiles(project: string, name: string, fromPath: string, fromText: string): Promise<string[]> {
  const ix = await indexOf(project)
  const cands = (ix.byName.get(name.toLowerCase()) ?? []).filter((f) => f.slice(f.lastIndexOf('/') + 1).replace(SRC_EXT, '') === name)
  const full = (rel: string): string => join(project, rel)
  const byFqcn = (fq: string): string[] => {
    const tail = '/' + fq.replace(/\./g, '/')
    return cands.filter((f) => f.replace(SRC_EXT, '').endsWith(tail)).map(full)
  }
  // explicit import
  const imp = fromText.match(new RegExp(`^\\s*import\\s+([\\w.]+\\.${esc(name)})\\s*;`, 'm'))?.[1]
  if (imp) return byFqcn(imp)
  // nested type in this file
  if (new RegExp(`\\b(?:class|interface|enum|record)\\s+${esc(name)}\\b`).test(code(fromText))) return [fromPath]
  // same package
  const pkg = packageOf(fromText)
  const same = byFqcn(pkg ? `${pkg}.${name}` : name)
  if (same.length) return same
  // wildcard imports
  for (const m of fromText.matchAll(/^\s*import\s+([\w.]+)\.\*\s*;/gm)) {
    const hit = byFqcn(`${m[1]}.${name}`)
    if (hit.length) return hit
  }
  // anywhere in the project (java.lang / library types have no file: nothing)
  return /^(String|Object|Integer|Long|Boolean|Double|Float|Short|Byte|Character|Math|System|Thread|Exception|RuntimeException|Override|Deprecated|List|Map|Set|Optional)$/.test(name)
    ? []
    : cands.map(full)
}

async function fileOfFqcn(project: string, fq: string): Promise<string[]> {
  const name = fq.slice(fq.lastIndexOf('.') + 1)
  const ix = await indexOf(project)
  const tail = '/' + fq.replace(/\./g, '/')
  return (ix.byName.get(name.toLowerCase()) ?? []).filter((f) => f.replace(SRC_EXT, '').endsWith(tail)).map((f) => join(project, f))
}

/* ------------------------------------------------------------------ Java members */

/** method or field declarations named `name` in one source */
function memberDecl(path: string, text: string, name: string, call: boolean): Loc[] {
  const c = code(text)
  const out: Loc[] = []
  const n = esc(name)
  if (call) {
    // <modifiers / return type> name(   — not a call (no '.', '=', '(' or keyword right before)
    const re = new RegExp(`(^|[;{}\\n])([ \\t]*(?:@\\w+(?:\\([^)]*\\))?\\s+)*)((?:[\\w$<>\\[\\],.?]+[ \\t]+)+)(${n})\\s*\\(`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(c))) {
      const words = m[3].trim().split(/\s+/)
      if (words.some((w) => KEYWORDS.has(w))) continue
      const at = m.index + m[0].length - m[0].slice(m[0].lastIndexOf(name)).length
      out.push({ path, ...posOf(text, at) })
    }
    // Kotlin
    out.push(...locIn(path, text, new RegExp(`\\bfun\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?(${n})\\s*\\(`, 'g')))
  } else {
    // field / constant / enum constant / Kotlin property
    const re = new RegExp(`([\\w$>\\]]+)\\s+(${n})\\s*(?:=(?!=)|;|,(?![^(]*\\)))`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(c))) {
      if (KEYWORDS.has(m[1])) continue // `return x;` is not a declaration
      out.push({ path, ...posOf(text, m.index + m[0].indexOf(m[2], m[1].length)) })
    }
    out.push(...locIn(path, text, new RegExp(`\\b(?:val|var)\\s+(${n})\\b`, 'g')))
    if (!out.length) out.push(...locIn(path, text, new RegExp(`^\\s*(${n})\\s*(?:\\(|,|;|\\{)`, 'gm')))
    // a getter / method of that name (method reference, Kotlin property access)
    if (!out.length) return memberDecl(path, text, name, true)
  }
  return out
}

/** super class and interfaces of the first type declared in `text` */
const superTypes = (text: string): string[] => {
  const m = code(text).match(/\b(?:class|interface|enum|record)\s+\w+(?:<[^{]*?>)?([^{]*)\{/)
  if (!m) return []
  return [...m[1].matchAll(/\b(?:extends|implements)\s+([^{]+?)(?=\bimplements\b|\bextends\b|$)/g)]
    .flatMap((x) => x[1].split(','))
    .map((s) => s.trim().replace(/<.*$/, '').split('.').pop() ?? '')
    .filter(Boolean)
}

/** declared type of a variable / field / parameter named `v` (nearest declaration before `before`) */
function varType(text: string, v: string, before: number): string | null {
  const c = code(text)
  const re = new RegExp(`\\b([A-Z][\\w$]*)(?:\\s*<[^;(){}=]*?>)?(?:\\[\\])*\\s+${esc(v)}\\b\\s*[=;,):]`, 'g')
  let best: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(c))) {
    if (m.index > before && best) break
    best = m[1]
  }
  // Kotlin: val x: Type / x: Type
  if (!best) best = c.match(new RegExp(`\\b${esc(v)}\\s*:\\s*([A-Z][\\w$]*)`))?.[1] ?? null
  return best
}

async function memberIn(project: string, owner: string, ownerFiles: string[], name: string, call: boolean, depth = 0): Promise<Loc[]> {
  const out: Loc[] = []
  for (const f of ownerFiles) {
    const t = await read(f)
    const hits = memberDecl(f, t, name, call)
    if (hits.length) {
      out.push(...hits)
      // MyBatis mapper interface: the SQL lives in the XML of the same namespace
      if (call && /\binterface\s+/.test(code(t))) {
        const fq = `${packageOf(t)}.${owner}`.replace(/^\./, '')
        for (const x of (await mappers(project)).get(fq.toLowerCase()) ?? []) {
          out.push(...locIn(x, await read(x), new RegExp(`<(?:select|insert|update|delete)\\b[^>]*\\bid\\s*=\\s*["'](${esc(name)})["']`), 1, true))
        }
      }
      continue
    }
    if (depth < 3) {
      for (const st of superTypes(t)) {
        const sf = await typeFiles(project, st, f, t)
        out.push(...(await memberIn(project, st, sf, name, call, depth + 1)))
      }
    }
  }
  return out
}

async function javaDefinition(project: string, path: string, text: string, offset: number): Promise<Loc[]> {
  const w = wordAt(text, offset, /[\w$]/)
  if (!w) return []
  const { word, start, end } = w
  // a.b.Class written out (imports, annotations): the whole dotted name
  const dotted = wordAt(text, offset, /[\w$.]/)
  if (dotted && /^[a-z][\w]*(\.[\w$]+)+$/.test(dotted.word) && /^[A-Z]/.test(word)) {
    const fq = dotted.word.slice(0, dotted.word.indexOf(word) + word.length)
    const files = await fileOfFqcn(project, fq)
    if (files.length) return (await Promise.all(files.map(async (f) => typeDecl(f, await read(f), word)))).flat()
  }
  const after = text.slice(end).match(/^\s*(\(|::)?/)?.[1]
  const call = after === '('
  const qualM = text.slice(0, start).match(/([\w$]+|\))\s*(\.|::)\s*$/)
  const qual = qualM?.[1] ?? null
  const isType = /^[A-Z]/.test(word) && !call && !(qual && /^[a-z]/.test(qual)) && !/^[A-Z0-9_]+$/.test(word)

  if (isType || (!qual && /^[A-Z]/.test(word) && call && /\bnew\s+$/.test(text.slice(0, start)))) {
    const files = await typeFiles(project, word, path, text)
    return (await Promise.all(files.map(async (f) => typeDecl(f, await read(f), word)))).flat()
  }

  // owner of the member
  let owner: string | null = null
  let ownerFiles: string[] = []
  const selfName = code(text).match(/\b(?:class|interface|enum|record)\s+(\w+)/)?.[1] ?? ''
  if (!qual || qual === 'this') {
    owner = selfName
    ownerFiles = [path]
  } else if (qual === 'super') {
    const st = superTypes(text)[0]
    if (st) {
      owner = st
      ownerFiles = await typeFiles(project, st, path, text)
    }
  } else if (qual !== ')') {
    owner = /^[A-Z]/.test(qual) ? qual : varType(text, qual, start)
    if (owner) ownerFiles = owner === selfName ? [path] : await typeFiles(project, owner, path, text)
  }
  if (owner && ownerFiles.length) {
    // the open file: use the editor text (may be unsaved)
    if (ownerFiles[0].toLowerCase() === path.toLowerCase()) {
      texts.set(path.toLowerCase(), { at: Date.now(), text })
    }
    const hits = await memberIn(project, owner, ownerFiles, word, call)
    if (hits.length) return hits
  }
  // local variable / parameter in this file
  if (!qual) {
    const local = varDecl(path, text, word, start)
    if (local) return [local]
  }
  return []
}

function varDecl(path: string, text: string, v: string, before: number): Loc | null {
  const c = code(text)
  const re = new RegExp(`(?:[\\w$>\\]]\\s+|\\bvar\\s+|\\bval\\s+)(${esc(v)})\\s*(?:[=;,):]|$)`, 'gm')
  let best: Loc | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(c))) {
    const at = m.index + m[0].lastIndexOf(v)
    if (at >= before) break
    best = { path, ...posOf(text, at) }
  }
  return best
}

/* ------------------------------------------------------------------ XML (MyBatis) */

async function xmlDefinition(project: string, path: string, text: string, offset: number): Promise<Loc[]> {
  const w = wordAt(text, offset, /[\w$.\-]/)
  if (!w) return []
  const attr = text.slice(0, w.start).match(/(\w+)\s*=\s*["'][^"']*$/)?.[1]?.toLowerCase()
  const value = w.word
  const ns = text.match(/<mapper\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/)?.[1]
  // statement id → mapper interface method
  if (attr === 'id' && ns && /<(select|insert|update|delete)\b[^<]*$/.test(text.slice(0, w.start))) {
    const files = await fileOfFqcn(project, ns)
    const out: Loc[] = []
    for (const f of files) out.push(...memberDecl(f, await read(f), value, true))
    return out
  }
  if (attr === 'resultmap' || attr === 'refid' || attr === 'extends') {
    const tag = attr === 'refid' ? 'sql' : 'resultMap'
    // "otherNamespace.id" points into another mapper
    const dot = value.lastIndexOf('.')
    const targets = dot > 0 ? (await mappers(project)).get(value.slice(0, dot).toLowerCase()) ?? [] : [path]
    const id = dot > 0 ? value.slice(dot + 1) : value
    const out: Loc[] = []
    for (const f of targets) out.push(...locIn(f, f === path ? text : await read(f), new RegExp(`<${tag}\\b[^>]*\\bid\\s*=\\s*["'](${esc(id)})["']`), 1, true))
    return out
  }
  return classByName(project, path, text, value)
}

/** a.b.Class (or a short alias that matches a project class) */
async function classByName(project: string, _path: string, _text: string, value: string): Promise<Loc[]> {
  const fq = value.replace(/\$.*/, '')
  if (/^[a-z][\w]*(\.[\w$]+)+$/.test(fq)) {
    // a.b.Class or a.b.Class.member
    let files = await fileOfFqcn(project, fq)
    let member: string | null = null
    if (!files.length && fq.includes('.')) {
      member = fq.slice(fq.lastIndexOf('.') + 1)
      files = await fileOfFqcn(project, fq.slice(0, fq.lastIndexOf('.')))
    }
    const out: Loc[] = []
    for (const f of files) {
      const t = await read(f)
      const name = (member ? fq.slice(0, fq.lastIndexOf('.')) : fq).split('.').pop()!
      out.push(...(member ? memberDecl(f, t, member, true) : typeDecl(f, t, name)))
    }
    return out
  }
  return []
}

/* ------------------------------------------------------------------ entry */

function wordAt(text: string, offset: number, ch: RegExp): { word: string; start: number; end: number } | null {
  let s = offset
  let e = offset
  while (s > 0 && ch.test(text[s - 1])) s--
  while (e < text.length && ch.test(text[e])) e++
  if (s === e) return null
  // trim dots at the edges of dotted names
  while (text[s] === '.') s++
  while (e > s && text[e - 1] === '.') e--
  return { word: text.slice(s, e), start: s, end: e }
}

/** Declarations for the symbol at `offset` of `path` (whose current editor text is `text`). */
export async function findDefinition(project: string, path: string, text: string, offset: number): Promise<Loc[]> {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  let out: Loc[] = []
  if (ext === 'java' || ext === 'kt') out = await javaDefinition(project, path, text, offset)
  else if (ext === 'xml') out = await xmlDefinition(project, path, text, offset)
  else {
    const w = wordAt(text, offset, /[\w$.]/)
    if (w) out = await classByName(project, path, text, w.word)
  }
  // drop duplicates and the spot itself
  const seen = new Set<string>()
  const here = posOf(text, offset).line
  return out.filter((l) => {
    const k = `${l.path.toLowerCase()}:${l.line}:${l.col}`
    if (seen.has(k)) return false
    seen.add(k)
    return !(l.path.toLowerCase() === path.toLowerCase() && l.line === here && out.length > 1)
  })
}
