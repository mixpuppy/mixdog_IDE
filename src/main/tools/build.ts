/** Maven / Gradle detection and build runner. */
import { promises as fs, existsSync } from 'fs'
import { join, delimiter } from 'path'
import type { ChildProcess } from 'child_process'
import { TOOLS_DIR, getTools, setTools } from '../core/settings'
import { publish } from '../core/events'
import { runCmd, killTree } from '../core/proc'
import { installZip, latestApacheVersion } from './download'

export type BuildTool = 'maven' | 'gradle' | null

export interface BuildInfo {
  tool: BuildTool
  /** executable that will run, or null if none could be found */
  exe: string | null
  /** how exe was found: wrapper / managed / path / custom */
  via: string
  defaultGoals: string
}

export const MAVEN_DIR = join(TOOLS_DIR, 'maven')

function onPath(name: string): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    for (const ext of ['.cmd', '.bat', '.exe']) {
      const p = join(dir, name + ext)
      if (existsSync(p)) return p
    }
  }
  return null
}

async function managedMaven(): Promise<string | null> {
  const custom = getTools().mavenHome
  if (custom && existsSync(join(custom, 'bin', 'mvn.cmd'))) return join(custom, 'bin', 'mvn.cmd')
  try {
    const dirs = (await fs.readdir(MAVEN_DIR)).filter((d) => d.startsWith('apache-maven-')).sort().reverse()
    for (const d of dirs) {
      const p = join(MAVEN_DIR, d, 'bin', 'mvn.cmd')
      if (existsSync(p)) return p
    }
  } catch {
    /* none */
  }
  return null
}

export async function detectBuild(projectDir: string): Promise<BuildInfo> {
  if (existsSync(join(projectDir, 'pom.xml'))) {
    const defaultGoals = 'clean package -DskipTests'
    const wrapper = join(projectDir, 'mvnw.cmd')
    if (existsSync(wrapper)) return { tool: 'maven', exe: wrapper, via: 'wrapper', defaultGoals }
    const managed = await managedMaven()
    if (managed) return { tool: 'maven', exe: managed, via: 'managed', defaultGoals }
    const path = onPath('mvn')
    return { tool: 'maven', exe: path, via: path ? 'path' : 'missing', defaultGoals }
  }
  const isGradle = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some((f) =>
    existsSync(join(projectDir, f))
  )
  if (isGradle) {
    const defaultGoals = 'clean build -x test'
    const wrapper = join(projectDir, 'gradlew.bat')
    if (existsSync(wrapper)) return { tool: 'gradle', exe: wrapper, via: 'wrapper', defaultGoals }
    const path = onPath('gradle')
    return { tool: 'gradle', exe: path, via: path ? 'path' : 'missing', defaultGoals }
  }
  return { tool: null, exe: null, via: 'none', defaultGoals: '' }
}

export async function downloadMaven(): Promise<string> {
  const v = await latestApacheVersion('https://dlcdn.apache.org/maven/maven-3/', '3.9.')
  const url = `https://dlcdn.apache.org/maven/maven-3/${v}/binaries/apache-maven-${v}-bin.zip`
  const home = await installZip(url, MAVEN_DIR, `Maven ${v}`)
  setTools({ mavenHome: home })
  return home
}

/** UTF-8 console output for the JVM (JDK 8 uses file.encoding, 18+ uses stdout.encoding). */
export const UTF8_OPTS = '-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8'

export function javaEnv(jdkHome: string | null): Record<string, string> {
  if (!jdkHome) return {}
  return { JAVA_HOME: jdkHome, PATH: `${join(jdkHome, 'bin')}${delimiter}${process.env['PATH'] ?? ''}` }
}

/** running builds per project folder (each IDE window can build its own project) */
const builds = new Map<string, ChildProcess>()
const keyOf = (p: string): string => p.toLowerCase()

export function isBuilding(projectDir?: string): boolean {
  return projectDir ? builds.has(keyOf(projectDir)) : builds.size > 0
}

export interface BuildOptions {
  /** add -o / --offline (unless the goals force a remote check); retried online once if an artifact is missing */
  offline?: boolean
  /** console label for build.start, e.g. "빠른 빌드" */
  label?: string
  /** runs after a successful build, before build.end (e.g. copy classes into the deployment); throw = build failed */
  after?: () => Promise<void>
}

const OFFLINE_MISS = /offline mode|has not been downloaded from it before|No cached version .* available for offline/i
/** projects whose build the user stopped (so a killed offline build is not retried online) */
const stopped = new Set<string>()

export async function runBuild(projectDir: string, jdkHome: string | null, goals: string | null, opts: BuildOptions = {}): Promise<boolean> {
  if (builds.has(keyOf(projectDir))) throw new Error('이 프로젝트는 이미 빌드 중입니다')
  const info = await detectBuild(projectDir)
  if (!info.tool) throw new Error('pom.xml 또는 build.gradle 을 찾을 수 없습니다')
  if (!info.exe) {
    throw new Error(
      info.tool === 'maven'
        ? 'Maven 을 찾을 수 없습니다. 프로젝트 설정에서 Maven 을 다운로드하세요.'
        : 'gradlew.bat 이 없고 gradle 도 PATH 에 없습니다.'
    )
  }
  const g = goals?.trim() || info.defaultGoals
  const forcesRemote = /(^|\s)(-U|--update-snapshots|--refresh-dependencies|-o|--offline)(\s|$)/.test(g)
  const offline = !!opts.offline && !forcesRemote
  const offlineFlag = info.tool === 'maven' ? '-o' : '--offline'
  const argsFor = (off: boolean): string =>
    (info.tool === 'maven' ? `-B ${off ? offlineFlag + ' ' : ''}${g}` : `--console=plain ${off ? offlineFlag + ' ' : ''}${g}`)
  const started = Date.now()
  stopped.delete(keyOf(projectDir))
  publish('build.start', { tool: info.tool, exe: info.exe, goals: offline ? `${offlineFlag} ${g}` : g, label: opts.label ?? null, jdkHome, projectDir }, 'system', projectDir)

  const runOnce = (args: string): Promise<{ code: number | null; offlineMiss: boolean }> =>
    new Promise((resolve) => {
      let offlineMiss = false
      const child = runCmd(info.exe!, args, {
        cwd: projectDir,
        env: {
          ...javaEnv(jdkHome),
          MAVEN_OPTS: UTF8_OPTS,
          GRADLE_OPTS: UTF8_OPTS
        },
        onLine: (line, stream) => {
          if (OFFLINE_MISS.test(line)) offlineMiss = true
          publish('build.output', { line, stream }, 'system', projectDir)
        },
        onExit: (code) => {
          builds.delete(keyOf(projectDir))
          resolve({ code, offlineMiss })
        }
      })
      builds.set(keyOf(projectDir), child)
    })

  let { code, offlineMiss } = await runOnce(argsFor(offline))
  if (code !== 0 && offline && offlineMiss && !stopped.has(keyOf(projectDir))) {
    publish('build.output', { line: '[mixdog] 오프라인에 없는 의존성이 있어 온라인으로 다시 빌드합니다…', stream: 'err' }, 'system', projectDir)
    ;({ code } = await runOnce(argsFor(false)))
  }
  let ok = code === 0
  if (ok && opts.after) {
    try {
      await opts.after()
    } catch (e) {
      ok = false
      publish('build.output', { line: `[mixdog] ${e instanceof Error ? e.message : String(e)}`, stream: 'err' }, 'system', projectDir)
    }
  }
  publish('build.end', { ok, code, ms: Date.now() - started }, 'system', projectDir)
  return ok
}

/** Kills the build; the normal exit handler then publishes build.end. */
export async function stopBuild(projectDir?: string): Promise<void> {
  const keys = projectDir ? [keyOf(projectDir)] : [...builds.keys()]
  for (const k of keys) {
    stopped.add(k)
    const c = builds.get(k)
    if (c) await killTree(c.pid)
  }
}

/**
 * `gradle tasks --all` output (for the Gradle tool window). Captured silently, not shown
 * in the build console. Can take a while the first time (Gradle daemon start).
 */
export async function gradleTasks(projectDir: string, jdkHome: string | null): Promise<string> {
  const info = await detectBuild(projectDir)
  if (info.tool !== 'gradle' || !info.exe) throw new Error('Gradle 프로젝트가 아니거나 gradle 을 찾을 수 없습니다')
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    const child = runCmd(info.exe!, 'tasks --all --console=plain', {
      cwd: projectDir,
      env: { ...javaEnv(jdkHome), GRADLE_OPTS: UTF8_OPTS },
      onLine: (line) => lines.push(line),
      onExit: (code) => {
        clearTimeout(timer)
        code === 0 ? resolve(lines.join('\n')) : reject(new Error(`gradle tasks 실패 (exit ${code})\n${lines.slice(-15).join('\n')}`))
      }
    })
    const timer = setTimeout(() => {
      killTree(child.pid)
      reject(new Error('gradle tasks 가 3분 안에 끝나지 않았습니다'))
    }, 180_000)
  })
}
