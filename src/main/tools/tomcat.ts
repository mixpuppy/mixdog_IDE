/**
 * Tomcat discovery, download and run.
 *
 * Like IntelliJ, the Tomcat installation (CATALINA_HOME) is never modified.
 * Each project gets its own CATALINA_BASE under %APPDATA%/mixdog-ide/tomcat-base
 * with a patched server.xml (port) and a context file pointing at the
 * project's exploded webapp, so JSP edits show up without redeploying.
 */
import { app } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join, basename, relative, dirname, sep } from 'path'
import { createHash } from 'crypto'
import { connect } from 'net'
import type { ChildProcess } from 'child_process'
import { TOOLS_DIR, getTools, type RunConfig } from '../core/settings'
import { publish } from '../core/events'
import { runCmd, killTree } from '../core/proc'
import { installZip, latestApacheVersion } from './download'
import { UTF8_OPTS } from './build'
import { inspectJdk } from './jdk'

export interface TomcatInfo {
  home: string
  version: string
  major: number
  managed: boolean
}

export const TOMCAT_DIR = join(TOOLS_DIR, 'tomcat')

/** Minimum Java major each Tomcat major needs. */
const MIN_JAVA: Record<number, number> = { 7: 6, 8: 7, 9: 8, 10: 11, 11: 17, 12: 21 }

export async function inspectTomcat(home: string): Promise<TomcatInfo | null> {
  if (!existsSync(join(home, 'bin', 'catalina.bat')) || !existsSync(join(home, 'lib', 'catalina.jar'))) return null
  let version = ''
  try {
    const notes = await fs.readFile(join(home, 'RELEASE-NOTES'), 'utf-8')
    version = notes.match(/Apache Tomcat Version\s+([\d.]+)/)?.[1] ?? ''
  } catch {
    /* fall back to folder name */
  }
  if (!version) version = basename(home).match(/(\d+(?:\.\d+)*)/)?.[1] ?? '?'
  const m = version.match(/^(\d+)(?:\.(\d+))?/)
  // 8.5 -> major 8, 10.1 -> 10
  return { home, version, major: m ? Number(m[1]) : 0, managed: home.startsWith(TOMCAT_DIR) }
}

export async function listTomcats(): Promise<TomcatInfo[]> {
  const candidates = new Set<string>()
  if (process.env['CATALINA_HOME']) candidates.add(process.env['CATALINA_HOME'])
  for (const t of getTools().extraTomcats) candidates.add(t)
  for (const root of ['C:\\Program Files\\Apache Software Foundation', 'C:\\Program Files (x86)\\Apache Software Foundation', TOMCAT_DIR]) {
    try {
      for (const d of await fs.readdir(root, { withFileTypes: true })) {
        if (d.isDirectory()) candidates.add(join(root, d.name))
      }
    } catch {
      /* missing root */
    }
  }
  const list = (await Promise.all([...candidates].map(inspectTomcat))).filter((t): t is TomcatInfo => !!t)
  const seen = new Set<string>()
  return list
    .filter((t) => !seen.has(t.home.toLowerCase()) && !!seen.add(t.home.toLowerCase()))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
}

export async function downloadTomcat(major: number): Promise<TomcatInfo | null> {
  const base = `https://dlcdn.apache.org/tomcat/tomcat-${major}/`
  const v = await latestApacheVersion(base, `${major}.`)
  const url = `${base}v${v}/bin/apache-tomcat-${v}-windows-x64.zip`
  const home = await installZip(url, TOMCAT_DIR, `Tomcat ${v}`)
  return inspectTomcat(home)
}

/* ------------------------------------------------------------------ */

/** Exploded webapp folder (has WEB-INF) or newest .war under target/ or build/. */
export async function findDeployable(projectDir: string): Promise<string | null> {
  const roots = [join(projectDir, 'target'), join(projectDir, 'build', 'libs'), join(projectDir, 'build', 'exploded'), join(projectDir, 'build')]
  for (const r of roots) {
    try {
      for (const d of await fs.readdir(r, { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(join(r, d.name, 'WEB-INF'))) return join(r, d.name)
      }
    } catch {
      /* missing */
    }
  }
  let best: { path: string; mtime: number } | null = null
  for (const r of roots) {
    try {
      for (const f of await fs.readdir(r)) {
        if (!f.endsWith('.war') || f.endsWith('-plain.war')) continue
        const p = join(r, f)
        const { mtimeMs } = await fs.stat(p)
        if (!best || mtimeMs > best.mtime) best = { path: p, mtime: mtimeMs }
      }
    } catch {
      /* missing */
    }
  }
  return best?.path ?? null
}

const xmlAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function contextFileName(contextPath: string): string {
  const p = contextPath.replace(/^\/+|\/+$/g, '')
  return p ? p.replace(/\//g, '#') : 'ROOT'
}

/**
 * Source deploy (IntelliJ Smart Tomcat): what Tomcat serves straight from the project.
 * null when the project has no src/main/webapp (or the run config asks for the exploded copy).
 */
export interface SourceDeploy {
  webRoot: string
  /** mounted at /WEB-INF/classes, in order */
  classes: string[]
  /** the build's WEB-INF/lib (dependency jars), mounted at /WEB-INF/lib */
  lib: string | null
}

export async function sourceDeploy(projectDir: string, cfg: RunConfig): Promise<SourceDeploy | null> {
  if (cfg.deployMode === 'exploded' || cfg.deployPath?.toLowerCase().endsWith('.war')) return null
  const webRoot = join(projectDir, 'src', 'main', 'webapp')
  if (!existsSync(webRoot)) return null
  const classes = [
    join(projectDir, 'target', 'classes'),
    ...['classes/java/main', 'classes/kotlin/main', 'classes/groovy/main', 'resources/main'].map((p) => join(projectDir, 'build', ...p.split('/')))
  ].filter((d) => existsSync(d))
  const exploded = cfg.deployPath || (await findDeployable(projectDir))
  const lib = exploded && !exploded.toLowerCase().endsWith('.war') && existsSync(join(exploded, 'WEB-INF', 'lib')) ? join(exploded, 'WEB-INF', 'lib') : null
  // Gradle makes no exploded folder (only a .war): without the libraries keep the old way
  if (!lib && (existsSync(join(projectDir, 'build.gradle')) || existsSync(join(projectDir, 'build.gradle.kts')))) return null
  return { webRoot, classes, lib }
}

function contextXml(docBase: string, src: SourceDeploy | null): string {
  const head = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated by mixdog IDE -->\n'
  if (!src) return `${head}<Context docBase="${xmlAttr(docBase)}" reloadable="false" />\n`
  // cacheTtl 1s: a file the application just wrote is found right away (default 5s)
  const sets = [
    ...src.classes.map((c) => `    <PreResources className="org.apache.catalina.webresources.DirResourceSet" base="${xmlAttr(c)}" webAppMount="/WEB-INF/classes" />`),
    ...(src.lib ? [`    <PostResources className="org.apache.catalina.webresources.DirResourceSet" base="${xmlAttr(src.lib)}" webAppMount="/WEB-INF/lib" />`] : [])
  ]
  return (
    `${head}<!-- source deploy (Smart Tomcat style): src/main/webapp served directly -->\n` +
    `<Context docBase="${xmlAttr(src.webRoot)}" reloadable="false">\n  <Resources cacheTtl="1000">\n${sets.join('\n')}\n  </Resources>\n</Context>\n`
  )
}

/** Create / refresh the per-project CATALINA_BASE. Returns its path. */
async function prepareBase(projectDir: string, home: string, cfg: RunConfig, docBase: string, src: SourceDeploy | null = null): Promise<string> {
  const id = createHash('sha1').update(projectDir.toLowerCase()).digest('hex').slice(0, 8)
  const base = join(app.getPath('userData'), 'tomcat-base', `${basename(projectDir)}-${id}`)
  const conf = join(base, 'conf')
  const marker = join(base, '.catalina-home')

  // Re-copy conf when the Tomcat installation changed (or first run).
  const prevHome = existsSync(marker) ? await fs.readFile(marker, 'utf-8') : ''
  if (prevHome !== home) {
    await fs.rm(base, { recursive: true, force: true })
    await fs.mkdir(base, { recursive: true })
    await fs.cp(join(home, 'conf'), conf, { recursive: true })
    await fs.copyFile(join(conf, 'server.xml'), join(conf, 'server.xml.orig'))
    await fs.writeFile(marker, home, 'utf-8')
  }
  for (const d of ['logs', 'temp', 'work', 'webapps']) await fs.mkdir(join(base, d), { recursive: true })

  // server.xml: our HTTP port, no shutdown port (we stop by killing), no AJP.
  let xml = await fs.readFile(join(conf, 'server.xml.orig'), 'utf-8')
  xml = xml
    .replace(/<Server\s+port="\d+"/, '<Server port="-1"')
    .replace(/(<Connector\s+port=")\d+("\s+protocol="HTTP\/1\.1")/, `$1${cfg.httpPort}$2`)
    .replace(/<Connector[^>]*protocol="AJP\/1\.3"[^>]*\/>/g, '')
  await fs.writeFile(join(conf, 'server.xml'), xml, 'utf-8')

  // Exactly one context: ours.
  const ctxDir = join(conf, 'Catalina', 'localhost')
  await fs.rm(ctxDir, { recursive: true, force: true })
  await fs.mkdir(ctxDir, { recursive: true })
  await fs.writeFile(
    join(ctxDir, `${contextFileName(cfg.contextPath)}.xml`),
    contextXml(docBase, src),
    'utf-8'
  )
  return base
}

/** True if something already accepts connections on the port (IPv4 or IPv6 loopback). */
function portInUse(port: number): Promise<boolean> {
  const probe = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const sock = connect({ port, host })
      sock.setTimeout(600)
      sock.once('connect', () => (sock.destroy(), resolve(true)))
      sock.once('timeout', () => (sock.destroy(), resolve(false)))
      sock.once('error', () => resolve(false))
    })
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then(([a, b]) => a || b)
}

/** One Tomcat per project (each IDE window runs its own; ports come from each run config). */
interface Running {
  proc: ChildProcess | null
  state: 'stopped' | 'starting' | 'running'
  projectDir: string
  /** what it serves, for hot-syncing saved web resources */
  docBase: string
  /** serves src/main/webapp itself: saved files need no copying */
  source?: boolean
  /** leave it running when the IDE quits */
  keep?: boolean
}
const servers = new Map<string, Running>()
const keyOf = (p: string): string => p.toLowerCase()

/**
 * IntelliJ-style "update resources on save": when a file under
 * src/main/webapp is saved while Tomcat runs an exploded deployment, copy it
 * into the deployed folder so JSP / JS / CSS changes show on browser refresh.
 */
export async function syncWebResource(savedPath: string): Promise<void> {
  for (const s of servers.values()) {
    if (!s.proc || s.source || s.docBase.endsWith('.war')) continue
    const webRoot = join(s.projectDir, 'src', 'main', 'webapp')
    const rel = relative(webRoot, savedPath)
    if (!rel || rel.startsWith('..') || rel.includes(':')) continue
    const dest = join(s.docBase, rel)
    await fs.mkdir(dirname(dest), { recursive: true })
    await fs.copyFile(savedPath, dest)
    publish('tomcat.sync', { file: rel.split(sep).join('/'), dest }, 'system', s.projectDir)
  }
}

export function tomcatState(projectDir?: string): string {
  if (projectDir) return servers.get(keyOf(projectDir))?.state ?? 'stopped'
  return [...servers.values()].some((s) => s.state === 'running') ? 'running' : servers.size ? 'starting' : 'stopped'
}

export function appUrl(cfg: RunConfig): string {
  const ctx = cfg.contextPath.replace(/\/+$/, '')
  return `http://localhost:${cfg.httpPort}${ctx.startsWith('/') ? ctx : '/' + ctx}/`.replace(/\/\/$/, '/')
}

/** Checks that don't need a build: Tomcat exists, JDK is new enough, ports are free. */
export async function checkRunConfig(projectDir: string, jdkHome: string | null, cfg: RunConfig, debug: boolean): Promise<{ tc: TomcatInfo; jdkMajor: number }> {
  if (servers.get(keyOf(projectDir))?.proc) throw new Error('이 프로젝트의 Tomcat 이 이미 실행 중입니다')
  if (!cfg.tomcatHome) throw new Error('실행 구성에서 Tomcat 을 선택하세요')
  const tc = await inspectTomcat(cfg.tomcatHome)
  if (!tc) throw new Error(`Tomcat 을 찾을 수 없습니다: ${cfg.tomcatHome}`)
  if (!jdkHome) throw new Error('프로젝트 JDK 가 설정되지 않았습니다')
  const jdk = await inspectJdk(jdkHome)
  if (!jdk) throw new Error(`JDK 를 찾을 수 없습니다: ${jdkHome}`)
  const need = MIN_JAVA[tc.major]
  if (need && jdk.major < need) {
    throw new Error(`Tomcat ${tc.version} 은 JDK ${need} 이상이 필요합니다 (현재 JDK ${jdk.major})`)
  }
  for (const [port, what] of [[cfg.httpPort, 'HTTP'], ...(debug ? [[cfg.debugPort, '디버그']] : [])] as [number, string][]) {
    if (await portInUse(port)) {
      throw new Error(`${what} 포트 ${port} 를 이미 다른 프로그램이 쓰고 있습니다 (다른 Tomcat 이 실행 중일 수 있음). 실행 구성에서 포트를 바꾸세요.`)
    }
  }
  return { tc, jdkMajor: jdk.major }
}

export async function startTomcat(projectDir: string, jdkHome: string | null, cfg: RunConfig, debug: boolean): Promise<void> {
  const { tc, jdkMajor } = await checkRunConfig(projectDir, jdkHome, cfg, debug)
  const src = await sourceDeploy(projectDir, cfg)
  const docBase = src ? src.webRoot : cfg.deployPath || (await findDeployable(projectDir))
  if (!docBase) throw new Error('배포할 결과물이 없습니다. 먼저 빌드하세요 (target/ 또는 build/ 에 war 나 exploded 폴더 필요)')
  if (src && !src.classes.length) throw new Error('컴파일된 클래스(target/classes)가 없습니다. 먼저 빌드하세요.')

  const base = await prepareBase(projectDir, tc.home, cfg, docBase, src)
  const srv: Running = { proc: null, state: 'starting', projectDir, docBase, source: !!src }
  servers.set(keyOf(projectDir), srv)
  const url = appUrl(cfg)
  const pub = (type: string, data: Record<string, unknown>): void => {
    publish(type, data, 'system', projectDir)
  }
  const shown = src
    ? `${docBase}  (소스 폴더 직접 배포 · 클래스: ${src.classes.map((c) => relative(projectDir, c)).join(', ')} · 라이브러리: ${src.lib ? relative(projectDir, src.lib) : '없음 - 빌드를 한 번 하세요'})`
    : docBase
  pub('tomcat.start', { version: tc.version, home: tc.home, base, docBase: shown, url, jdkHome, debug, debugPort: debug ? cfg.debugPort : null })

  const env: Record<string, string | undefined> = {
    CATALINA_HOME: tc.home,
    CATALINA_BASE: base,
    JAVA_HOME: jdkHome!,
    JRE_HOME: undefined,
    CATALINA_OPTS: undefined,
    JAVA_OPTS: `${UTF8_OPTS} ${cfg.vmOptions}`.trim()
  }
  if (debug) {
    env['JPDA_TRANSPORT'] = 'dt_socket'
    env['JPDA_ADDRESS'] = jdkMajor >= 9 ? `*:${cfg.debugPort}` : String(cfg.debugPort)
  }

  srv.proc = runCmd(join(tc.home, 'bin', 'catalina.bat'), debug ? 'jpda run' : 'run', {
    cwd: base,
    env,
    onLine: (line, stream) => {
      pub('tomcat.output', { line, stream })
      if (srv.state === 'starting' && /Server startup in|서버가 .*시작/.test(line)) {
        srv.state = 'running'
        pub('tomcat.started', { url })
      }
      // Connector failed to bind -> Tomcat keeps running but is unreachable; stop it.
      if (srv.state !== 'running' && /Address already in use|BindException/.test(line)) {
        srv.state = 'stopped'
        pub('tomcat.error', { message: `포트 ${cfg.httpPort} 를 이미 다른 프로그램이 쓰고 있어 Tomcat 을 중지했습니다. 실행 구성에서 포트를 바꾸세요.` })
        if (srv.proc) killTree(srv.proc.pid)
      }
    },
    onExit: (code) => {
      srv.proc = null
      srv.state = 'stopped'
      if (servers.get(keyOf(projectDir)) === srv) servers.delete(keyOf(projectDir))
      pub('tomcat.stop', { code })
    }
  })
}

export async function stopTomcat(projectDir?: string): Promise<void> {
  const list = projectDir ? [servers.get(keyOf(projectDir))] : [...servers.values()]
  for (const s of list) if (s?.proc) await killTree(s.proc.pid)
}

/** the user chose "계속 실행" when closing the IDE */
export function keepOnQuit(projectDir: string): void {
  const s = servers.get(keyOf(projectDir))
  if (s) s.keep = true
}

// Quitting: wait until every Tomcat is really gone (taskkill), otherwise the IDE exits first and
// the server keeps running in the background. Servers the user chose to keep are left alone.
let quitting = false
app.on('before-quit', (e) => {
  const list = [...servers.values()].filter((s) => s.proc && !s.keep)
  if (quitting || !list.length) return
  e.preventDefault()
  quitting = true
  void Promise.race([Promise.all(list.map((s) => killTree(s.proc!.pid))), new Promise((r) => setTimeout(r, 8000))]).finally(() => app.quit())
})
