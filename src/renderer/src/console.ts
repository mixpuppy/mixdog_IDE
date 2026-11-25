/**
 * Console buffer for build / Tomcat output that stays light under a flood of log lines:
 * - lines arriving in the same frame are applied together (one screen update per frame)
 * - lines are kept in blocks; a full block never changes, so the view skips re-rendering it
 * - the colour class is worked out once per line, not on every render
 * Not reactive itself: `tick` (reactive) tells the view that something changed.
 */
import { reactive, markRaw } from 'vue'

export interface ConsoleLine {
  id: number
  text: string
  err: boolean
  cls: string
}

export interface ConsoleBlock {
  id: number
  lines: ConsoleLine[]
}

const BLOCK = 200
/** lines kept (IntelliJ keeps about 1 MB of console text; older lines are dropped in whole blocks) */
const MAX_LINES = 20000

let lineSeq = 0
let blockSeq = 0

function kindOf(text: string, err: boolean): string {
  if (/^\s*(▶|■)/.test(text)) return 'head'
  if (/^✔|BUILD SUCCESS|Server startup in/.test(text)) return 'ok'
  if (err || /\[ERROR\]|SEVERE|BUILD FAILURE|FAILED|Exception|^✖|심각/.test(text)) return 'err'
  if (/\[WARNING\]|WARN|경고/.test(text)) return 'warn'
  if (/^\s+at |^\[INFO\] -+$|^\s*$/.test(text)) return 'dim'
  return ''
}

export class ConsoleBuf {
  blocks: ConsoleBlock[] = []
  count = 0
  /** bumped after every applied batch (the view watches it) */
  readonly state = reactive({ tick: 0, empty: true })
  pending: { text: string; err: boolean }[] = []
  scheduled = false

  add(text: string, err = false): void {
    this.pending.push({ text, err })
    // a hidden window gets no animation frames: don't let the queue grow without end
    if (this.pending.length > MAX_LINES) this.pending.splice(0, this.pending.length - MAX_LINES)
    if (!this.scheduled) {
      this.scheduled = true
      const run = (): void => this.flush()
      if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(run)
      else setTimeout(run, 50)
    }
  }

  flush(): void {
    this.scheduled = false
    if (!this.pending.length) return
    for (const p of this.pending) {
      let b = this.blocks[this.blocks.length - 1]
      if (!b || b.lines.length >= BLOCK) {
        b = { id: ++blockSeq, lines: [] }
        this.blocks.push(b)
      }
      b.lines.push({ id: ++lineSeq, text: p.text, err: p.err, cls: kindOf(p.text, p.err) })
      this.count++
    }
    this.pending = []
    while (this.count > MAX_LINES && this.blocks.length > 1) this.count -= this.blocks.shift()!.lines.length
    this.state.empty = this.count === 0
    this.state.tick++
  }

  clear(): void {
    this.blocks = []
    this.pending = []
    this.count = 0
    this.state.empty = true
    this.state.tick++
  }

  /** last n lines as text (Claude's get_console) */
  tail(n: number): string[] {
    const out: string[] = []
    for (let i = this.blocks.length - 1; i >= 0 && out.length < n; i--) {
      const ls = this.blocks[i].lines
      for (let j = ls.length - 1; j >= 0 && out.length < n; j--) out.push(ls[j].text)
    }
    return out.reverse().concat(this.pending.map((p) => p.text)).slice(-n)
  }
}

export const newConsole = (): ConsoleBuf => markRaw(new ConsoleBuf())
