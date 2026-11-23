/**
 * Compiler problems from build output (no language server: the build the IDE already runs
 * is the source of truth). Understands Maven (javac / kotlin plugins) and Gradle output.
 *
 * The list of a project is replaced whenever a build actually compiled something, so a
 * dependency-only goal keeps the last compile result.
 */
import { normalize, isAbsolute, join } from 'path'

export interface Problem {
  file: string
  line: number
  col: number
  severity: 'error' | 'warning'
  message: string
}

const MAX = 500
const byProject = new Map<string, Problem[]>()
const key = (dir: string): string => normalize(dir).toLowerCase()

export const getProblems = (projectDir: string): Problem[] => byProject.get(key(projectDir)) ?? []

export function setProblems(projectDir: string, list: Problem[]): void {
  byProject.set(key(projectDir), list)
}

/** a compile step ran (so its problems replace the old list) */
const COMPILE_STEP = /maven-compiler-plugin|--- compiler:|kotlin-maven-plugin|--- kotlin:|> Task :(\S+:)?compile(Java|Kotlin|Groovy|TestJava|TestKotlin)\b/

// [ERROR] /D:/work/app/src/main/java/a/Foo.java:[12,8] cannot find symbol
const MAVEN = /^\[(ERROR|WARNING)\]\s+(?:file:\/+)?\/?(.+?\.(?:java|kt|groovy|scala)):\[(\d+),(\d+)\]\s*(.*)$/
// [ERROR] file:///D:/work/app/src/main/kotlin/A.kt:12:8 Unresolved reference: x   (kotlin-maven-plugin)
// e: file:///D:/work/app/src/main/kotlin/A.kt:12:8 Unresolved reference: x            (Gradle Kotlin)
const KOTLIN = /^(?:\[(ERROR|WARNING)\]|(e|w):)\s+(?:file:\/+)?\/?(.+?\.kts?):(\d+):(\d+)\s+(.*)$/
// D:\work\app\src\main\java\a\Foo.java:12: error: cannot find symbol      (Gradle javac)
const GRADLE = /^(.+?\.java):(\d+):\s*(error|warning):\s*(.*)$/
// extra detail lines of javac (symbol / location / required / found)
const DETAIL = /^(?:\[(?:ERROR|WARNING)\])?\s+(symbol|location|required|found|reason)\s*:/

function filePath(raw: string, projectDir: string): string {
  let p = raw.replace(/^\/(?=[A-Za-z]:)/, '')
  try {
    p = decodeURIComponent(p)
  } catch {
    /* keep */
  }
  return normalize(isAbsolute(p) ? p : join(projectDir, p))
}

/** Feed build output line by line; `result()` gives the deduplicated problems. */
export class ProblemCollector {
  compiled = false
  private list: Problem[] = []
  private seen = new Set<string>()
  private last: Problem | null = null
  /** Gradle javac: the next lines are the source line and a caret line (gives the column) */
  private gradleStage: 0 | 1 | 2 = 0
  private srcLine = ''

  constructor(private projectDir: string) {}

  private add(p: Problem): void {
    const k = `${p.file.toLowerCase()}:${p.line}:${p.col}:${p.message}`
    if (this.seen.has(k)) {
      // Maven repeats every error in the summary: keep the first, ignore the copy
      this.last = null
      return
    }
    this.seen.add(k)
    if (this.list.length < MAX) this.list.push(p)
    this.last = p
  }

  feed(line: string): void {
    if (COMPILE_STEP.test(line)) this.compiled = true
    if (this.gradleStage === 1) {
      this.srcLine = line
      this.gradleStage = 2
      return
    }
    if (this.gradleStage === 2) {
      this.gradleStage = 0
      const caret = line.indexOf('^')
      if (caret >= 0 && this.last && /^\s*\^\s*$/.test(line)) {
        this.last.col = caret + 1
        return
      }
    }
    let m = line.match(MAVEN)
    if (m) {
      this.compiled = true
      this.add({ file: filePath(m[2], this.projectDir), line: +m[3], col: +m[4], severity: m[1] === 'ERROR' ? 'error' : 'warning', message: m[5].trim() })
      return
    }
    m = line.match(KOTLIN)
    if (m) {
      this.compiled = true
      const err = m[1] === 'ERROR' || m[2] === 'e'
      this.add({ file: filePath(m[3], this.projectDir), line: +m[4], col: +m[5], severity: err ? 'error' : 'warning', message: m[6].trim() })
      return
    }
    m = line.match(GRADLE)
    if (m) {
      this.compiled = true
      this.add({ file: filePath(m[1], this.projectDir), line: +m[2], col: 1, severity: m[3] === 'error' ? 'error' : 'warning', message: m[4].trim() })
      this.gradleStage = 1
      this.srcLine = ''
      return
    }
    const d = line.match(DETAIL)
    if (d && this.last) {
      this.last.message += `\n${line.replace(/^\[(?:ERROR|WARNING)\]/, '').trim().replace(/\s+/g, ' ')}`
      return
    }
    // anything else ends the detail lines of the last problem
    if (line.trim()) this.last = null
  }

  result(): Problem[] {
    return this.list
  }
}

/** Plain-text list for Claude / logs: `path:line:col: error: message` */
export function formatProblems(list: Problem[], projectDir?: string): string {
  if (!list.length) return '문제 없음 (컴파일 오류·경고 0건)'
  const rel = (f: string): string => (projectDir && f.toLowerCase().startsWith(normalize(projectDir).toLowerCase()) ? f.slice(normalize(projectDir).length + 1) : f)
  const errors = list.filter((p) => p.severity === 'error').length
  const head = `오류 ${errors}건, 경고 ${list.length - errors}건`
  return [head, ...list.map((p) => `${rel(p.file)}:${p.line}:${p.col}: ${p.severity}: ${p.message.replace(/\n/g, ' | ')}`)].join('\n')
}
