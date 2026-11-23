/**
 * Minimal JDWP (Java Debug Wire Protocol) client over TCP: the protocol the JVM speaks on the
 * debug port (`catalina jpda run`). No extra process, no language server.
 *
 * Only the commands the debugger UI needs are wrapped here; IDs are kept as bigint.
 * Spec: https://docs.oracle.com/en/java/javase/21/docs/specs/jdwp/jdwp-protocol.html
 */
import { Socket, connect } from 'net'

export type Id = bigint

export interface Location {
  tag: number
  classId: Id
  methodId: Id
  index: bigint
}

/** a tagged value: tag is the JDWP type char ('I', 'L', 's', '[' ...) */
export interface Value {
  tag: string
  v: unknown
}

export interface JEvent {
  kind: number
  requestId: number
  thread?: Id
  location?: Location
  /** CLASS_PREPARE */
  typeId?: Id
  signature?: string
}

export const EventKind = { SINGLE_STEP: 1, BREAKPOINT: 2, CLASS_PREPARE: 8, VM_START: 90, VM_DEATH: 99 } as const
export const Suspend = { NONE: 0, THREAD: 1, ALL: 2 } as const

class Writer {
  private parts: Buffer[] = []
  constructor(private sizes: Sizes) {}
  byte(n: number): this {
    this.parts.push(Buffer.from([n & 0xff]))
    return this
  }
  int(n: number): this {
    const b = Buffer.alloc(4)
    b.writeInt32BE(n)
    this.parts.push(b)
    return this
  }
  long(n: bigint): this {
    const b = Buffer.alloc(8)
    b.writeBigInt64BE(n)
    this.parts.push(b)
    return this
  }
  str(s: string): this {
    const d = Buffer.from(s, 'utf-8')
    this.int(d.length)
    this.parts.push(d)
    return this
  }
  id(n: Id, size: number): this {
    const b = Buffer.alloc(size)
    if (size === 8) b.writeBigUInt64BE(BigInt.asUintN(64, n))
    else b.writeUInt32BE(Number(n))
    this.parts.push(b)
    return this
  }
  obj(n: Id): this {
    return this.id(n, this.sizes.object)
  }
  ref(n: Id): this {
    return this.id(n, this.sizes.refType)
  }
  method(n: Id): this {
    return this.id(n, this.sizes.method)
  }
  field(n: Id): this {
    return this.id(n, this.sizes.field)
  }
  frame(n: Id): this {
    return this.id(n, this.sizes.frame)
  }
  loc(l: Location): this {
    return this.byte(l.tag).ref(l.classId).method(l.methodId).long(l.index)
  }
  buf(): Buffer {
    return Buffer.concat(this.parts)
  }
}

export class Reader {
  private p = 0
  constructor(
    private b: Buffer,
    private sizes: Sizes
  ) {}
  byte(): number {
    return this.b.readUInt8(this.p++)
  }
  bool(): boolean {
    return this.byte() !== 0
  }
  short(): number {
    const v = this.b.readInt16BE(this.p)
    this.p += 2
    return v
  }
  char(): string {
    const v = this.b.readUInt16BE(this.p)
    this.p += 2
    return String.fromCharCode(v)
  }
  int(): number {
    const v = this.b.readInt32BE(this.p)
    this.p += 4
    return v
  }
  long(): bigint {
    const v = this.b.readBigInt64BE(this.p)
    this.p += 8
    return v
  }
  float(): number {
    const v = this.b.readFloatBE(this.p)
    this.p += 4
    return v
  }
  double(): number {
    const v = this.b.readDoubleBE(this.p)
    this.p += 8
    return v
  }
  str(): string {
    const n = this.int()
    const s = this.b.toString('utf-8', this.p, this.p + n)
    this.p += n
    return s
  }
  id(size: number): Id {
    const v = size === 8 ? this.b.readBigUInt64BE(this.p) : BigInt(this.b.readUInt32BE(this.p))
    this.p += size
    return v
  }
  obj(): Id {
    return this.id(this.sizes.object)
  }
  ref(): Id {
    return this.id(this.sizes.refType)
  }
  method(): Id {
    return this.id(this.sizes.method)
  }
  field(): Id {
    return this.id(this.sizes.field)
  }
  frame(): Id {
    return this.id(this.sizes.frame)
  }
  loc(): Location {
    return { tag: this.byte(), classId: this.ref(), methodId: this.method(), index: this.long() }
  }
  /** value of a known type (untagged) */
  untagged(tag: string): Value {
    switch (tag) {
      case 'Z':
        return { tag, v: this.bool() }
      case 'B':
        return { tag, v: (this.byte() << 24) >> 24 }
      case 'C':
        return { tag, v: this.char() }
      case 'S':
        return { tag, v: this.short() }
      case 'I':
        return { tag, v: this.int() }
      case 'J':
        return { tag, v: this.long() }
      case 'F':
        return { tag, v: this.float() }
      case 'D':
        return { tag, v: this.double() }
      case 'V':
        return { tag, v: null }
      default:
        return { tag, v: this.obj() }
    }
  }
  tagged(): Value {
    return this.untagged(String.fromCharCode(this.byte()))
  }
}

interface Sizes {
  field: number
  method: number
  object: number
  refType: number
  frame: number
}

interface Pending {
  resolve: (r: Reader) => void
  reject: (e: Error) => void
}

/** JDWP error codes worth a readable message */
const ERRORS: Record<number, string> = {
  10: 'INVALID_THREAD',
  13: 'THREAD_NOT_SUSPENDED',
  20: 'INVALID_OBJECT',
  21: 'INVALID_CLASS',
  23: 'INVALID_METHODID',
  30: 'INVALID_FRAMEID',
  35: 'INVALID_SLOT',
  41: 'NOT_FOUND',
  101: 'ABSENT_INFORMATION',
  112: 'VM_DEAD'
}

export class JdwpError extends Error {
  constructor(
    public code: number,
    what: string
  ) {
    super(`JDWP ${what}: ${ERRORS[code] ?? code}`)
  }
}

export class Jdwp {
  sizes: Sizes = { field: 8, method: 8, object: 8, refType: 8, frame: 8 }
  private sock!: Socket
  private seq = 1
  private pending = new Map<number, Pending>()
  private acc = Buffer.alloc(0)
  private handshaken = false
  onEvents: (suspend: number, events: JEvent[]) => void = () => {}
  onClose: () => void = () => {}
  closed = false

  /** Connect and handshake; rejects quickly when nothing listens on the port. */
  static async connect(host: string, port: number): Promise<Jdwp> {
    const j = new Jdwp()
    await new Promise<void>((resolve, reject) => {
      const s = connect({ host, port })
      j.sock = s
      const fail = (e: Error): void => {
        s.destroy()
        reject(e)
      }
      s.once('error', fail)
      s.once('connect', () => s.write('JDWP-Handshake'))
      s.on('data', (d) => {
        if (!j.handshaken) {
          j.acc = Buffer.concat([j.acc, d])
          if (j.acc.length < 14) return
          if (j.acc.subarray(0, 14).toString() !== 'JDWP-Handshake') return fail(new Error('JDWP 핸드셰이크 실패'))
          j.handshaken = true
          j.acc = j.acc.subarray(14)
          s.off('error', fail)
          s.on('error', () => j.close())
          resolve()
          if (j.acc.length) j.drain()
          return
        }
        j.acc = Buffer.concat([j.acc, d])
        j.drain()
      })
      s.on('close', () => j.close())
    })
    const r = await j.cmd(1, 7) // IDSizes
    j.sizes = { field: r.int(), method: r.int(), object: r.int(), refType: r.int(), frame: r.int() }
    return j
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.sock?.destroy()
    for (const p of this.pending.values()) p.reject(new Error('디버그 연결이 끊어졌습니다'))
    this.pending.clear()
    this.onClose()
  }

  private drain(): void {
    while (this.acc.length >= 11) {
      const len = this.acc.readUInt32BE(0)
      if (this.acc.length < len) return
      const pkt = this.acc.subarray(0, len)
      this.acc = this.acc.subarray(len)
      const id = pkt.readUInt32BE(4)
      const flags = pkt.readUInt8(8)
      if (flags & 0x80) {
        const err = pkt.readUInt16BE(9)
        const p = this.pending.get(id)
        this.pending.delete(id)
        if (!p) continue
        if (err) p.reject(new JdwpError(err, `command ${id}`))
        else p.resolve(new Reader(pkt.subarray(11), this.sizes))
      } else if (pkt.readUInt8(9) === 64 && pkt.readUInt8(10) === 100) {
        try {
          this.parseEvents(new Reader(pkt.subarray(11), this.sizes))
        } catch {
          /* an event kind we don't parse: ignore the packet */
        }
      }
    }
  }

  private parseEvents(r: Reader): void {
    const suspend = r.byte()
    const n = r.int()
    const out: JEvent[] = []
    for (let i = 0; i < n; i++) {
      const kind = r.byte()
      const requestId = r.int()
      if (kind === EventKind.VM_DEATH) {
        out.push({ kind, requestId })
      } else if (kind === EventKind.VM_START) {
        out.push({ kind, requestId, thread: r.obj() })
      } else if (kind === EventKind.SINGLE_STEP || kind === EventKind.BREAKPOINT) {
        out.push({ kind, requestId, thread: r.obj(), location: r.loc() })
      } else if (kind === EventKind.CLASS_PREPARE) {
        const thread = r.obj()
        r.byte() // refTypeTag
        const typeId = r.ref()
        const signature = r.str()
        r.int() // status
        out.push({ kind, requestId, thread, typeId, signature })
      } else break // unknown layout: stop parsing this packet
    }
    this.onEvents(suspend, out)
  }

  w(): Writer {
    return new Writer(this.sizes)
  }

  cmd(set: number, command: number, data?: Writer | Buffer): Promise<Reader> {
    if (this.closed) return Promise.reject(new Error('디버그 연결이 끊어졌습니다'))
    const body = data instanceof Writer ? data.buf() : data ?? Buffer.alloc(0)
    const id = this.seq++
    const head = Buffer.alloc(11)
    head.writeUInt32BE(11 + body.length, 0)
    head.writeUInt32BE(id, 4)
    head.writeUInt8(0, 8)
    head.writeUInt8(set, 9)
    head.writeUInt8(command, 10)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.sock.write(Buffer.concat([head, body]))
    })
  }

  /* ------------------------------------------------------------ wrapped commands */

  async version(): Promise<string> {
    const r = await this.cmd(1, 1)
    const desc = r.str()
    r.int()
    r.int()
    const vmVersion = r.str()
    const vmName = r.str()
    return `${vmName} ${vmVersion}`.trim() || desc
  }

  async classesBySignature(sig: string): Promise<Id[]> {
    const r = await this.cmd(1, 2, this.w().str(sig))
    const n = r.int()
    const out: Id[] = []
    for (let i = 0; i < n; i++) {
      r.byte()
      out.push(r.ref())
      r.int()
    }
    return out
  }

  /** all loaded classes: signature -> type id */
  async allClasses(): Promise<{ id: Id; sig: string }[]> {
    const r = await this.cmd(1, 3)
    const n = r.int()
    const out: { id: Id; sig: string }[] = []
    for (let i = 0; i < n; i++) {
      r.byte()
      const id = r.ref()
      const sig = r.str()
      r.int()
      out.push({ id, sig })
    }
    return out
  }

  async allThreads(): Promise<Id[]> {
    const r = await this.cmd(1, 4)
    const n = r.int()
    return Array.from({ length: n }, () => r.obj())
  }

  dispose(): Promise<Reader> {
    return this.cmd(1, 6)
  }
  resumeAll(): Promise<Reader> {
    return this.cmd(1, 9)
  }

  async signature(type: Id): Promise<string> {
    return (await this.cmd(2, 1, this.w().ref(type))).str()
  }

  async fields(type: Id): Promise<{ id: Id; name: string; sig: string; mod: number }[]> {
    const r = await this.cmd(2, 4, this.w().ref(type))
    const n = r.int()
    return Array.from({ length: n }, () => ({ id: r.field(), name: r.str(), sig: r.str(), mod: r.int() }))
  }

  async methods(type: Id): Promise<{ id: Id; name: string; sig: string; mod: number }[]> {
    const r = await this.cmd(2, 5, this.w().ref(type))
    const n = r.int()
    return Array.from({ length: n }, () => ({ id: r.method(), name: r.str(), sig: r.str(), mod: r.int() }))
  }

  async staticValues(type: Id, fields: Id[]): Promise<Value[]> {
    const w = this.w().ref(type).int(fields.length)
    for (const f of fields) w.field(f)
    const r = await this.cmd(2, 6, w)
    const n = r.int()
    return Array.from({ length: n }, () => r.tagged())
  }

  async sourceFile(type: Id): Promise<string> {
    return (await this.cmd(2, 7, this.w().ref(type))).str()
  }

  async superclass(cls: Id): Promise<Id> {
    return (await this.cmd(3, 1, this.w().ref(cls))).ref()
  }

  async lineTable(type: Id, method: Id): Promise<{ start: bigint; end: bigint; lines: { index: bigint; line: number }[] }> {
    const r = await this.cmd(6, 1, this.w().ref(type).method(method))
    const start = r.long()
    const end = r.long()
    const n = r.int()
    return { start, end, lines: Array.from({ length: n }, () => ({ index: r.long(), line: r.int() })) }
  }

  async variableTable(type: Id, method: Id): Promise<{ argCount: number; vars: { start: bigint; name: string; sig: string; length: number; slot: number }[] }> {
    const r = await this.cmd(6, 2, this.w().ref(type).method(method))
    const argCount = r.int()
    const n = r.int()
    return { argCount, vars: Array.from({ length: n }, () => ({ start: r.long(), name: r.str(), sig: r.str(), length: r.int(), slot: r.int() })) }
  }

  async objectType(obj: Id): Promise<Id> {
    const r = await this.cmd(9, 1, this.w().obj(obj))
    r.byte()
    return r.ref()
  }

  async objectValues(obj: Id, fields: Id[]): Promise<Value[]> {
    const w = this.w().obj(obj).int(fields.length)
    for (const f of fields) w.field(f)
    const r = await this.cmd(9, 2, w)
    const n = r.int()
    return Array.from({ length: n }, () => r.tagged())
  }

  async stringValue(obj: Id): Promise<string> {
    return (await this.cmd(10, 1, this.w().obj(obj))).str()
  }

  async threadName(t: Id): Promise<string> {
    return (await this.cmd(11, 1, this.w().obj(t))).str()
  }

  resumeThread(t: Id): Promise<Reader> {
    return this.cmd(11, 3, this.w().obj(t))
  }

  async threadStatus(t: Id): Promise<{ status: number; suspended: boolean }> {
    const r = await this.cmd(11, 4, this.w().obj(t))
    return { status: r.int(), suspended: (r.int() & 1) === 1 }
  }

  async frames(t: Id): Promise<{ id: Id; loc: Location }[]> {
    const r = await this.cmd(11, 6, this.w().obj(t).int(0).int(-1))
    const n = r.int()
    return Array.from({ length: n }, () => ({ id: r.frame(), loc: r.loc() }))
  }

  async arrayLength(arr: Id): Promise<number> {
    return (await this.cmd(13, 1, this.w().obj(arr))).int()
  }

  async arrayValues(arr: Id, first: number, length: number): Promise<Value[]> {
    const r = await this.cmd(13, 2, this.w().obj(arr).int(first).int(length))
    const tag = String.fromCharCode(r.byte())
    const n = r.int()
    const prim = 'ZBCSIJFD'.includes(tag)
    return Array.from({ length: n }, () => (prim ? r.untagged(tag) : r.tagged()))
  }

  async frameValues(t: Id, frame: Id, slots: { slot: number; tag: string }[]): Promise<Value[]> {
    const w = this.w().obj(t).frame(frame).int(slots.length)
    for (const s of slots) w.int(s.slot).byte(s.tag.charCodeAt(0))
    const r = await this.cmd(16, 1, w)
    const n = r.int()
    return Array.from({ length: n }, () => r.tagged())
  }

  async thisObject(t: Id, frame: Id): Promise<Value> {
    return (await this.cmd(16, 3, this.w().obj(t).frame(frame))).tagged()
  }

  /** EventRequest.Set; modifiers are written by `mods` */
  async request(kind: number, suspend: number, mods: (w: Writer) => number): Promise<number> {
    const body = this.w()
    const mw = this.w()
    const count = mods(mw)
    body.byte(kind).byte(suspend).int(count)
    const r = await this.cmd(15, 1, Buffer.concat([body.buf(), mw.buf()]))
    return r.int()
  }

  clearRequest(kind: number, id: number): Promise<Reader> {
    return this.cmd(15, 2, this.w().byte(kind).int(id))
  }
}

export type { Writer }
