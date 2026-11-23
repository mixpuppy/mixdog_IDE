/**
 * Debug sessions (one per project): attach to Tomcat's JDWP port, line breakpoints (with a
 * simple condition), stepping, call stack and variables. The UI only sees plain data:
 * handles are strings, values are display text.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { publish } from '../core/events'
import { listFiles } from '../tools/search'
import { tomcatState } from '../tools/tomcat'
import { Jdwp, EventKind, Suspend, JdwpError, type Id, type Location, type Value, type JEvent } from './jdwp'

export interface Breakpoint {
  path: string
  line: number
  condition?: string
  enabled: boolean
}

export interface BpStatus {
  path: string
  line: number
  /** line the JVM actually stops at (blank / comment lines move to the next code line) */
  actual?: number
  verified: boolean
}

export interface FrameInfo {
  handle: string
  cls: string
  method: string
  line: number
  path: string | null
}

export interface VarInfo {
  name: string
  type: string
  value: string
  /** expandable object / array */
  ref?: string
}

/** classes the debugger steps through instead of into (frameworks, JDK) */
const STEP_EXCLUDE = ['java.*', 'javax.*', 'jakarta.*', 'sun.*', 'com.sun.*', 'jdk.*', 'org.apache.*', 'org.springframework.*', 'org.mybatis.*', 'org.hibernate.*', 'com.zaxxer.*', 'org.slf4j.*', 'ch.qos.*', 'net.sf.cglib.*', 'org.aspectj.*', 'com.fasterxml.*']

const key = (p: string): string => p.toLowerCase()
const sigToName = (sig: string): string => sig.replace(/^L/, '').replace(/;$/, '').replace(/\//g, '.')
const simple = (sig: string): string => {
  let s = sig
  let dims = ''
  while (s.startsWith('[')) {
    dims += '[]'
    s = s.slice(1)
  }
  const prim: Record<string, string> = { Z: 'boolean', B: 'byte', C: 'char', S: 'short', I: 'int', J: 'long', F: 'float', D: 'double', V: 'void' }
  const base = prim[s] ?? sigToName(s).split('.').pop()!.replace(/\$/g, '.')
  return base + dims
}

class Session {
  j: Jdwp
  bps: Breakpoint[] = []
  status = new Map<string, BpStatus>()
  /** breakpoint request id -> breakpoint key */
  bpReq = new Map<number, string>()
  prepReq: number[] = []
  paused: { thread: Id } | null = null
  stepReq: number | null = null
  frames = new Map<string, { thread: Id; frame: Id; loc: Location }>()
  refs = new Map<string, { id: Id; tag: string }>()
  private sigs = new Map<string, string>()
  private methodsOf = new Map<string, { id: Id; name: string; sig: string; mod: number }[]>()
  private lines = new Map<string, { index: bigint; line: number }[]>()
  private fieldsOf = new Map<string, { id: Id; name: string; sig: string; mod: number }[]>()
  private supers = new Map<string, Id>()
  private paths = new Map<string, string | null>()
  private loaded: { id: Id; sig: string }[] = []

  constructor(
    j: Jdwp,
    public project: string
  ) {
    this.j = j
  }

  pub(type: string, data: Record<string, unknown>): void {
    publish(type, data, 'system', this.project)
  }

  /* ---------------------------------------------------------- metadata (cached) */

  async sig(type: Id): Promise<string> {
    const k = type.toString()
    let s = this.sigs.get(k)
    if (!s) {
      s = await this.j.signature(type)
      this.sigs.set(k, s)
    }
    return s
  }

  async methods(type: Id): Promise<{ id: Id; name: string; sig: string; mod: number }[]> {
    const k = type.toString()
    let m = this.methodsOf.get(k)
    if (!m) {
      m = await this.j.methods(type)
      this.methodsOf.set(k, m)
    }
    return m
  }

  async lineTable(type: Id, method: Id): Promise<{ index: bigint; line: number }[]> {
    const k = `${type}:${method}`
    let l = this.lines.get(k)
    if (!l) {
      try {
        l = (await this.j.lineTable(type, method)).lines
      } catch {
        l = [] // native / abstract / no debug info
      }
      this.lines.set(k, l)
    }
    return l
  }

  async fields(type: Id): Promise<{ id: Id; name: string; sig: string; mod: number }[]> {
    const k = type.toString()
    let f = this.fieldsOf.get(k)
    if (!f) {
      f = await this.j.fields(type)
      this.fieldsOf.set(k, f)
    }
    return f
  }

  async superOf(type: Id): Promise<Id> {
    const k = type.toString()
    let s = this.supers.get(k)
    if (s === undefined) {
      try {
        s = await this.j.superclass(type)
      } catch {
        s = 0n // interface / array
      }
      this.supers.set(k, s)
    }
    return s
  }

  async lineOf(loc: Location): Promise<number> {
    const t = await this.lineTable(loc.classId, loc.methodId)
    let best = -1
    let bestIdx = -1n
    for (const e of t) if (e.index <= loc.index && e.index >= bestIdx) {
      bestIdx = e.index
      best = e.line
    }
    return best
  }

  /** project source file of a class (nested / anonymous classes map to their top-level file) */
  async pathOf(type: Id): Promise<string | null> {
    const k = type.toString()
    if (this.paths.has(k)) return this.paths.get(k)!
    const name = sigToName(await this.sig(type)).replace(/\$.*/, '')
    let src = ''
    try {
      src = await this.j.sourceFile(type)
    } catch {
      /* no SourceFile attribute */
    }
    const pkg = name.includes('.') ? name.slice(0, name.lastIndexOf('.')).replace(/\./g, '/') + '/' : ''
    const file = src || name.split('.').pop() + '.java'
    const files = await listFiles(this.project)
    const tail = '/' + pkg + file
    const hit = files.find((f) => ('/' + f).endsWith(tail))
    const full = hit ? join(this.project, hit) : null
    this.paths.set(k, full)
    return full
  }

  /* ---------------------------------------------------------- breakpoints */

  /** fully qualified class of a source file (package line + file name) */
  async classOf(path: string): Promise<string | null> {
    try {
      const text = await fs.readFile(path, 'utf-8')
      const pkg = text.match(/^\s*package\s+([\w.]+)\s*;?/m)?.[1]
      const name = path.split(/[\\/]/).pop()!.replace(/\.(java|kt)$/i, '')
      return pkg ? `${pkg}.${name}` : name
    } catch {
      return null
    }
  }

  async setBreakpoints(list: Breakpoint[]): Promise<void> {
    this.bps = list.filter((b) => b.enabled)
    for (const [id] of this.bpReq) await this.j.clearRequest(EventKind.BREAKPOINT, id).catch(() => {})
    for (const id of this.prepReq) await this.j.clearRequest(EventKind.CLASS_PREPARE, id).catch(() => {})
    this.bpReq.clear()
    this.prepReq = []
    this.status.clear()
    for (const b of this.bps) this.status.set(`${key(b.path)}:${b.line}`, { path: b.path, line: b.line, verified: false })
    // classes per file
    const byClass = new Map<string, Breakpoint[]>()
    for (const b of this.bps) {
      const cls = await this.classOf(b.path)
      if (cls) byClass.set(cls, [...(byClass.get(cls) ?? []), b])
    }
    if (!this.loaded.length) this.loaded = await this.j.allClasses()
    for (const [cls, bps] of byClass) {
      const top = `L${cls.replace(/\./g, '/')};`
      const nested = `L${cls.replace(/\./g, '/')}$`
      for (const c of this.loaded) if (c.sig === top || c.sig.startsWith(nested)) await this.install(c.id, bps)
      // classes loaded later (the webapp loads lazily): stop the loading thread, install, go on
      for (const pattern of [cls, `${cls}$*`]) {
        const id = await this.j.request(EventKind.CLASS_PREPARE, Suspend.THREAD, (w) => {
          w.byte(5).str(pattern)
          return 1
        })
        this.prepReq.push(id)
      }
    }
    this.publishStatus()
  }

  private publishStatus(): void {
    this.pub('debug.breakpoints', { list: [...this.status.values()] })
  }

  /** breakpoints of the file of `type` that fall into its methods */
  async install(type: Id, bps: Breakpoint[]): Promise<void> {
    const methods = await this.methods(type)
    const tables = await Promise.all(methods.map(async (m) => ({ m, t: await this.lineTable(type, m.id) })))
    for (const b of bps) {
      const st = this.status.get(`${key(b.path)}:${b.line}`)
      // the method whose lines contain the breakpoint line; the code line at or after it
      let best: { m: Id; index: bigint; line: number } | null = null
      for (const { m, t } of tables) {
        if (!t.length) continue
        const min = Math.min(...t.map((e) => e.line))
        const max = Math.max(...t.map((e) => e.line))
        if (b.line < min - 1 || b.line > max) continue
        for (const e of t) {
          if (e.line < b.line) continue
          if (!best || e.line < best.line || (e.line === best.line && e.index < best.index)) best = { m: m.id, index: e.index, line: e.line }
        }
      }
      if (!best) continue
      const loc: Location = { tag: 1, classId: type, methodId: best.m, index: best.index }
      try {
        const id = await this.j.request(EventKind.BREAKPOINT, Suspend.ALL, (w) => {
          w.byte(7).loc(loc)
          return 1
        })
        this.bpReq.set(id, `${key(b.path)}:${b.line}`)
        if (st) {
          st.verified = true
          st.actual = best.line
        }
      } catch {
        /* class unloaded meanwhile */
      }
    }
  }

  /* ---------------------------------------------------------- events */

  async onEvents(suspend: number, events: JEvent[]): Promise<void> {
    for (const e of events) {
      if (e.kind === EventKind.CLASS_PREPARE && e.typeId !== undefined) {
        const cls = sigToName(e.signature ?? '').replace(/\$.*/, '')
        const bps: Breakpoint[] = []
        for (const b of this.bps) if ((await this.classOf(b.path)) === cls) bps.push(b)
        this.loaded.push({ id: e.typeId, sig: e.signature ?? '' })
        if (bps.length) {
          await this.install(e.typeId, bps).catch(() => {})
          this.publishStatus()
        }
        if (suspend !== Suspend.NONE && e.thread !== undefined) await this.j.resumeThread(e.thread).catch(() => {})
      } else if ((e.kind === EventKind.BREAKPOINT || e.kind === EventKind.SINGLE_STEP) && e.thread !== undefined && e.location) {
        if (this.paused) continue // already stopped (two events at one spot)
        if (e.kind === EventKind.BREAKPOINT) {
          const bk = this.bpReq.get(e.requestId)
          const bp = bk ? this.bps.find((b) => `${key(b.path)}:${b.line}` === bk) : undefined
          if (bp?.condition?.trim() && !(await this.condition(bp.condition, e.thread, e.location))) {
            await this.j.resumeAll()
            continue
          }
        }
        await this.clearStep()
        this.paused = { thread: e.thread }
        await this.publishPaused(e.kind === EventKind.BREAKPOINT ? 'breakpoint' : 'step')
      } else if (e.kind === EventKind.VM_DEATH) {
        this.j.close()
      }
    }
  }

  async clearStep(): Promise<void> {
    if (this.stepReq !== null) {
      await this.j.clearRequest(EventKind.SINGLE_STEP, this.stepReq).catch(() => {})
      this.stepReq = null
    }
  }

  async threadsInfo(): Promise<{ id: string; name: string }[]> {
    const ids = await this.j.allThreads()
    const out: { id: string; name: string }[] = []
    for (const t of ids) {
      try {
        out.push({ id: t.toString(), name: await this.j.threadName(t) })
      } catch {
        /* thread ended */
      }
    }
    return out
  }

  async publishPaused(reason: string): Promise<void> {
    const t = this.paused!.thread
    const frames = await this.framesOf(t)
    const threads = await this.threadsInfo()
    this.pub('debug.paused', { reason, thread: t.toString(), threads, frames })
  }

  async framesOf(thread: Id): Promise<FrameInfo[]> {
    this.frames.clear()
    this.refs.clear()
    const list = await this.j.frames(thread)
    const out: FrameInfo[] = []
    for (const f of list.slice(0, 200)) {
      const handle = `${thread}:${f.id}`
      this.frames.set(handle, { thread, frame: f.id, loc: f.loc })
      let method = '?'
      let cls = '?'
      try {
        cls = sigToName(await this.sig(f.loc.classId))
        method = (await this.methods(f.loc.classId)).find((m) => m.id === f.loc.methodId)?.name ?? '?'
      } catch {
        /* unloaded */
      }
      out.push({ handle, cls, method, line: await this.lineOf(f.loc), path: await this.pathOf(f.loc.classId).catch(() => null) })
    }
    return out
  }

  /* ---------------------------------------------------------- values */

  private hold(id: Id, tag: string): string {
    const h = `${tag}${id}`
    this.refs.set(h, { id, tag })
    return h
  }

  async typeSig(obj: Id): Promise<string> {
    return this.sig(await this.j.objectType(obj))
  }

  /** all instance fields (own first, then super classes up to Object) */
  async instanceFields(obj: Id): Promise<{ name: string; sig: string; v: Value }[]> {
    const out: { name: string; sig: string; v: Value }[] = []
    let t = await this.j.objectType(obj)
    for (let depth = 0; t && depth < 12; depth++) {
      const s = await this.sig(t)
      if (s === 'Ljava/lang/Object;') break
      const fs = (await this.fields(t)).filter((f) => !(f.mod & 0x0008))
      if (fs.length) {
        const vals = await this.j.objectValues(obj, fs.map((f) => f.id))
        fs.forEach((f, i) => out.push({ name: f.name, sig: f.sig, v: vals[i] }))
      }
      t = await this.superOf(t)
    }
    return out
  }

  async field(obj: Id, name: string): Promise<Value | null> {
    return (await this.instanceFields(obj)).find((f) => f.name === name)?.v ?? null
  }

  async isEnum(obj: Id): Promise<boolean> {
    let t = await this.j.objectType(obj)
    for (let i = 0; t && i < 4; i++) {
      t = await this.superOf(t)
      if (t && (await this.sig(t)) === 'Ljava/lang/Enum;') return true
    }
    return false
  }

  /** display text of a value (strings, boxed numbers, dates, collections get a readable form) */
  async describe(name: string, v: Value, declSig = ''): Promise<VarInfo> {
    const tag = v.tag
    if ('ZBCSIJFD'.includes(tag)) {
      const val = tag === 'C' ? `'${v.v}'` : String(v.v)
      return { name, type: simple(tag), value: val }
    }
    const id = v.v as Id
    if (!id) return { name, type: declSig ? simple(declSig) : '', value: 'null' }
    try {
      if (tag === 's') {
        const s = await this.j.stringValue(id)
        return { name, type: 'String', value: JSON.stringify(s.length > 500 ? s.slice(0, 500) + '…' : s) }
      }
      const sig = await this.typeSig(id)
      const type = simple(sig)
      if (tag === '[') {
        const n = await this.j.arrayLength(id)
        return { name, type, value: `${type.replace(/\[\]$/, `[${n}]`)}`, ref: n ? this.hold(id, '[') : undefined }
      }
      const cls = sigToName(sig)
      const field = async (f: string): Promise<unknown> => (await this.field(id, f))?.v
      const ref = this.hold(id, 'L')
      switch (cls) {
        case 'java.lang.Integer':
        case 'java.lang.Long':
        case 'java.lang.Short':
        case 'java.lang.Byte':
        case 'java.lang.Double':
        case 'java.lang.Float':
        case 'java.lang.Boolean':
          return { name, type, value: String(await field('value')) }
        case 'java.lang.Character':
          return { name, type, value: `'${await field('value')}'` }
        case 'java.math.BigDecimal': {
          const compact = (await field('intCompact')) as bigint
          const scale = Number(await field('scale'))
          if (compact !== -9223372036854775808n) {
            const neg = compact < 0n
            let digits = (neg ? -compact : compact).toString()
            if (scale > 0) {
              digits = digits.padStart(scale + 1, '0')
              digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
            } else if (scale < 0) digits += '0'.repeat(-scale)
            return { name, type, value: (neg ? '-' : '') + digits, ref }
          }
          return { name, type, value: 'BigDecimal (큰 값)', ref }
        }
        case 'java.util.Date':
        case 'java.sql.Timestamp':
        case 'java.sql.Date': {
          const ms = Number(await field('fastTime'))
          const d = new Date(ms)
          const p = (n: number): string => String(n).padStart(2, '0')
          return { name, type, value: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`, ref }
        }
        case 'java.time.LocalDate':
          return { name, type, value: await this.localDate(id), ref }
        case 'java.time.LocalDateTime': {
          const date = (await field('date')) as Id
          const time = (await field('time')) as Id
          return { name, type, value: `${await this.localDate(date)} ${await this.localTime(time)}`, ref }
        }
        case 'java.time.LocalTime':
          return { name, type, value: await this.localTime(id), ref }
        case 'java.util.ArrayList':
        case 'java.util.LinkedList':
        case 'java.util.HashMap':
        case 'java.util.LinkedHashMap':
        case 'java.util.TreeMap':
        case 'java.util.concurrent.ConcurrentHashMap':
        case 'java.util.HashSet':
        case 'java.util.LinkedHashSet': {
          let size = await field('size')
          if (size === undefined) {
            const m = (await field('map')) as Id
            size = m ? (await this.field(m, 'size'))?.v : '?'
          }
          return { name, type, value: `size = ${size}`, ref }
        }
      }
      if (await this.isEnum(id)) {
        const n = (await this.field(id, 'name'))?.v as Id
        return { name, type, value: n ? await this.j.stringValue(n) : type, ref }
      }
      return { name, type, value: `{${type}@${id}}`, ref }
    } catch (e) {
      return { name, type: '', value: e instanceof JdwpError ? '(값을 읽을 수 없음)' : String(e) }
    }
  }

  private async localDate(id: Id): Promise<string> {
    if (!id) return 'null'
    const p = (n: unknown): string => String(n).padStart(2, '0')
    return `${(await this.field(id, 'year'))?.v}-${p((await this.field(id, 'month'))?.v)}-${p((await this.field(id, 'day'))?.v)}`
  }

  private async localTime(id: Id): Promise<string> {
    if (!id) return 'null'
    const p = (n: unknown): string => String(n).padStart(2, '0')
    return `${p((await this.field(id, 'hour'))?.v)}:${p((await this.field(id, 'minute'))?.v)}:${p((await this.field(id, 'second'))?.v)}`
  }

  /** children of an object / array handle */
  async children(handle: string): Promise<VarInfo[]> {
    const r = this.refs.get(handle)
    if (!r) return []
    const id = r.id
    if (r.tag === '[') {
      const n = Math.min(await this.j.arrayLength(id), 200)
      const vals = n ? await this.j.arrayValues(id, 0, n) : []
      return Promise.all(vals.map((v, i) => this.describe(`[${i}]`, v)))
    }
    const cls = sigToName(await this.typeSig(id))
    if (cls === 'java.util.ArrayList') {
      const size = Number((await this.field(id, 'size'))?.v ?? 0)
      const data = (await this.field(id, 'elementData'))?.v as Id
      const vals = size && data ? await this.j.arrayValues(data, 0, Math.min(size, 200)) : []
      return Promise.all(vals.map((v, i) => this.describe(`[${i}]`, v)))
    }
    if (/^java\.util\.(HashMap|LinkedHashMap|HashSet|LinkedHashSet)$/.test(cls)) {
      const set = cls.endsWith('Set')
      const map = set ? ((await this.field(id, 'map'))?.v as Id) : id
      const table = map ? ((await this.field(map, 'table'))?.v as Id) : 0n
      const out: VarInfo[] = []
      if (table) {
        const n = await this.j.arrayLength(table)
        const buckets = n ? await this.j.arrayValues(table, 0, n) : []
        for (const b of buckets) {
          let node = b.v as Id
          while (node && out.length < 200) {
            const k = await this.field(node, 'key')
            const v = await this.field(node, 'value')
            const kd = k ? await this.describe('', k) : null
            if (set) out.push(await this.describe(`[${out.length}]`, k!))
            else out.push(await this.describe(kd ? kd.value : '?', v!))
            node = (await this.field(node, 'next'))?.v as Id
          }
        }
      }
      return out
    }
    const fs = await this.instanceFields(id)
    return Promise.all(fs.map((f) => this.describe(f.name, f.v, f.sig)))
  }

  /** local variables (+ this) of a frame */
  async variables(handle: string): Promise<{ vars: VarInfo[]; note?: string }> {
    const f = this.frames.get(handle)
    if (!f) return { vars: [] }
    const out: VarInfo[] = []
    let note: string | undefined
    try {
      const vt = await this.j.variableTable(f.loc.classId, f.loc.methodId)
      const visible = vt.vars.filter((v) => f.loc.index >= v.start && f.loc.index < v.start + BigInt(v.length) && v.name !== 'this')
      if (visible.length) {
        const vals = await this.j.frameValues(f.thread, f.frame, visible.map((v) => ({ slot: v.slot, tag: v.sig[0] === '[' ? '[' : v.sig[0] })))
        // arguments first, then locals in declaration order
        const items = visible.map((v, i) => ({ v, val: vals[i] })).sort((a, b) => a.v.slot - b.v.slot)
        for (const it of items) out.push(await this.describe(it.v.name, it.val, it.v.sig))
      }
    } catch (e) {
      if (e instanceof JdwpError && e.code === 101) note = '변수 정보가 없습니다 (디버그 정보 없이 컴파일된 클래스)'
      else note = String((e as Error).message ?? e)
    }
    try {
      const self = await this.j.thisObject(f.thread, f.frame)
      if (self.v) out.unshift(await this.describe('this', self))
    } catch {
      /* static method */
    }
    return { vars: out, note }
  }

  /* ---------------------------------------------------------- conditions */

  /** `a == 1`, `name != null`, `user.id > 3`, `name.equals("x")`, `flag` — anything else stops */
  async condition(cond: string, thread: Id, loc: Location): Promise<boolean> {
    try {
      const frames = await this.j.frames(thread)
      const top = frames[0]
      if (!top) return true
      const handle = `${thread}:${top.id}`
      this.frames.set(handle, { thread, frame: top.id, loc })
      const { vars } = await this.variables(handle)
      const lookup = async (path: string): Promise<string | null> => {
        const parts = path.split('.')
        let cur = vars.find((v) => v.name === parts[0])
        if (!cur) {
          const self = vars.find((v) => v.name === 'this')
          if (self?.ref) cur = (await this.children(self.ref)).find((v) => v.name === parts[0])
        }
        for (const p of parts.slice(1)) {
          if (!cur?.ref) return null
          cur = (await this.children(cur.ref)).find((v) => v.name === p)
        }
        if (!cur) return null
        return cur.value
      }
      const eq = cond.match(/^\s*([\w.]+)\.equals\(\s*"([^"]*)"\s*\)\s*$/)
      if (eq) return (await lookup(eq[1])) === JSON.stringify(eq[2])
      const m = cond.match(/^\s*([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/)
      if (!m) {
        const b = await lookup(cond.trim())
        return b === null ? true : b === 'true'
      }
      const left = await lookup(m[1])
      if (left === null) return true
      let right = m[3]
      if (/^".*"$/.test(right)) right = JSON.stringify(JSON.parse(right))
      const ln = Number(left)
      const rn = Number(right)
      const num = !isNaN(ln) && !isNaN(rn) && left !== '' && right !== ''
      switch (m[2]) {
        case '==':
          return num ? ln === rn : left === right
        case '!=':
          return num ? ln !== rn : left !== right
        case '>':
          return num && ln > rn
        case '<':
          return num && ln < rn
        case '>=':
          return num && ln >= rn
        case '<=':
          return num && ln <= rn
      }
      return true
    } catch {
      return true
    }
  }

  /* ---------------------------------------------------------- run control */

  async resume(): Promise<void> {
    if (!this.paused) return
    this.paused = null
    this.frames.clear()
    this.refs.clear()
    await this.clearStep()
    this.pub('debug.resumed', {})
    await this.j.resumeAll()
  }

  /** depth: 0 into · 1 over · 2 out */
  async step(depth: 0 | 1 | 2): Promise<void> {
    if (!this.paused) return
    const t = this.paused.thread
    await this.clearStep()
    this.stepReq = await this.j.request(EventKind.SINGLE_STEP, Suspend.ALL, (w) => {
      w.byte(10).obj(t).int(1).int(depth)
      w.byte(1).int(1)
      for (const p of STEP_EXCLUDE) w.byte(6).str(p)
      return 2 + STEP_EXCLUDE.length
    })
    this.paused = null
    this.frames.clear()
    this.refs.clear()
    this.pub('debug.resumed', { step: true })
    await this.j.resumeAll()
  }
}

/* ------------------------------------------------------------------ sessions by project */

const sessions = new Map<string, Session>()
/** breakpoints by project (kept while no session runs; applied on attach) */
const breakpoints = new Map<string, Breakpoint[]>()

export const debugState = (project: string): { attached: boolean; paused: boolean } => {
  const s = sessions.get(key(project))
  return { attached: !!s, paused: !!s?.paused }
}

/** Attach to the debug port of the project's Tomcat (retries while Tomcat starts). */
export async function attachDebugger(project: string, port: number, host = '127.0.0.1'): Promise<void> {
  if (sessions.has(key(project))) return
  const until = Date.now() + 90_000
  let j: Jdwp | null = null
  while (!j && Date.now() < until) {
    try {
      j = await Jdwp.connect(host, port)
    } catch {
      if (tomcatState(project) === 'stopped' && Date.now() > until - 85_000) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  if (!j) {
    publish('debug.error', { message: `디버그 포트 ${port} 에 연결하지 못했습니다` }, 'system', project)
    return
  }
  const s = new Session(j, project)
  sessions.set(key(project), s)
  let chain = Promise.resolve()
  // events one at a time (installing a breakpoint must finish before the next class event)
  j.onEvents = (suspend, events) => {
    chain = chain.then(() =>
      s.onEvents(suspend, events).catch((e) => {
        publish('debug.error', { message: String(e?.message ?? e) }, 'system', project)
      })
    )
  }
  j.onClose = () => {
    if (sessions.get(key(project)) === s) sessions.delete(key(project))
    publish('debug.detached', {}, 'system', project)
  }
  const version = await j.version().catch(() => '')
  publish('debug.attached', { port, version }, 'system', project)
  await s.setBreakpoints(breakpoints.get(key(project)) ?? [])
}

export async function detachDebugger(project: string): Promise<void> {
  const s = sessions.get(key(project))
  if (!s) return
  // dispose removes all breakpoints and resumes the VM
  await s.j.dispose().catch(() => {})
  s.j.close()
}

export async function setBreakpoints(project: string, list: Breakpoint[]): Promise<void> {
  breakpoints.set(key(project), list)
  await sessions.get(key(project))?.setBreakpoints(list)
}

const need = (project: string): Session => {
  const s = sessions.get(key(project))
  if (!s) throw new Error('디버그 중이 아닙니다')
  return s
}

export const resume = (project: string): Promise<void> => need(project).resume()
export const step = (project: string, depth: 0 | 1 | 2): Promise<void> => need(project).step(depth)
export const variables = (project: string, frame: string): Promise<{ vars: VarInfo[]; note?: string }> => need(project).variables(frame)
export const children = (project: string, ref: string): Promise<VarInfo[]> => need(project).children(ref)

/** frames of another (suspended) thread */
export async function threadFrames(project: string, thread: string): Promise<FrameInfo[]> {
  return need(project).framesOf(BigInt(thread))
}
