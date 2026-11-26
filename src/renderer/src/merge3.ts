/**
 * Three-way line merge (diff3) for the conflict resolver: base / ours / theirs.
 * Blocks changed on one side only (or the same on both) are merged automatically,
 * like IntelliJ's "apply non-conflicting changes"; the rest are conflicts.
 */

/** matching line pairs between a and b (longest common subsequence, Myers O(ND)) */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  // common prefix / suffix first: most of a file is unchanged
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  const mid = myers(A, B).map(([i, j]) => [i + pre, j + pre] as [number, number])
  const out: [number, number][] = []
  for (let i = 0; i < pre; i++) out.push([i, i])
  out.push(...mid)
  for (let i = 0; i < suf; i++) out.push([a.length - suf + i, b.length - suf + i])
  return out
}

function myers(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  if (!n || !m) return []
  const max = n + m
  const v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  const off = max + 1
  let found = false
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
    // very different files: give up on an exact LCS (treat as one changed block)
    if (d > 4000) return []
  }
  // backtrack
  const pairs: [number, number][] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1
    const prevX = vv[off + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      pairs.push([x, y])
    }
    if (d > 0) {
      x = prevX
      y = prevY
    }
  }
  return pairs.reverse()
}

export interface Range {
  /** first line (0-based) and count */
  start: number
  len: number
}

export type Block =
  | { kind: 'same'; lines: string[] }
  /** smart: both sides changed the block, but different lines of it (merged line by line) */
  | { kind: 'auto'; side: 'ours' | 'theirs' | 'both' | 'smart'; lines: string[]; base: Range; ours: Range; theirs: Range }
  | { kind: 'conflict'; baseLines: string[]; oursLines: string[]; theirsLines: string[]; base: Range; ours: Range; theirs: Range }

const eq = (x: string[], y: string[]): boolean => x.length === y.length && x.every((s, i) => s === y[i])

/**
 * Same number of lines on all three sides and every line changed on at most one side (or the same
 * way on both): merge line by line. Git calls edits on neighbouring lines a conflict; they aren't.
 */
function lineByLine(b: string[], o: string[], t: string[]): string[] | null {
  if (!b.length || b.length !== o.length || b.length !== t.length) return null
  const out: string[] = []
  for (let i = 0; i < b.length; i++) {
    if (o[i] === b[i]) out.push(t[i])
    else if (t[i] === b[i] || t[i] === o[i]) out.push(o[i])
    else return null
  }
  return out
}

export function merge3(base: string[], ours: string[], theirs: string[]): Block[] {
  const mo = new Map(lcsPairs(base, ours).map(([b, o]) => [b, o]))
  const mt = new Map(lcsPairs(base, theirs).map(([b, t]) => [b, t]))
  const blocks: Block[] = []
  let bi = 0
  let oi = 0
  let ti = 0
  const pushSame = (line: string): void => {
    const last = blocks[blocks.length - 1]
    if (last?.kind === 'same') last.lines.push(line)
    else blocks.push({ kind: 'same', lines: [line] })
  }
  const flush = (b1: number, o1: number, t1: number): void => {
    const bl = base.slice(bi, b1)
    const ol = ours.slice(oi, o1)
    const tl = theirs.slice(ti, t1)
    if (!bl.length && !ol.length && !tl.length) return
    const r = { base: { start: bi, len: bl.length }, ours: { start: oi, len: ol.length }, theirs: { start: ti, len: tl.length } }
    if (eq(ol, bl)) blocks.push({ kind: 'auto', side: 'theirs', lines: tl, ...r })
    else if (eq(tl, bl)) blocks.push({ kind: 'auto', side: 'ours', lines: ol, ...r })
    else if (eq(ol, tl)) blocks.push({ kind: 'auto', side: 'both', lines: ol, ...r })
    else {
      const smart = lineByLine(bl, ol, tl)
      if (smart) blocks.push({ kind: 'auto', side: 'smart', lines: smart, ...r })
      else blocks.push({ kind: 'conflict', baseLines: bl, oursLines: ol, theirsLines: tl, ...r })
    }
  }
  // walk base lines that are kept on both sides (stable anchors)
  for (let b = 0; b < base.length; b++) {
    const o = mo.get(b)
    const t = mt.get(b)
    if (o === undefined || t === undefined || o < oi || t < ti) continue
    flush(b, o, t)
    pushSame(base[b])
    bi = b + 1
    oi = o + 1
    ti = t + 1
  }
  flush(base.length, ours.length, theirs.length)
  return blocks
}

export function splitLines(text: string): { lines: string[]; eol: string; finalNewline: boolean } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const finalNewline = /\r?\n$/.test(text)
  const body = finalNewline ? text.replace(/\r?\n$/, '') : text
  return { lines: body === '' && !finalNewline ? [] : body.split(/\r?\n/), eol, finalNewline }
}
