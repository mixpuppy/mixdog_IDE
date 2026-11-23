/**
 * IntelliJ-style fast build before run ("Build artifacts: exploded").
 *
 * Instead of `clean package` (wipe target/, recompile everything, copy the whole
 * webapp, zip a .war nobody deploys), we:
 *   1. run only the incremental compile (Maven `compile`, Gradle `classes`),
 *   2. copy the classes / web files that changed into the exploded folder Tomcat serves.
 * The exploded folder itself (with WEB-INF/lib) is created once by `war:exploded` and
 * re-created only when pom.xml / build.gradle changes (dependencies may have changed).
 */
import { promises as fs, existsSync } from 'fs'
import { join, basename } from 'path'
import { createHash } from 'crypto'
import type { RunConfig } from '../core/settings'
import { publish } from '../core/events'
import { detectBuild, runBuild } from './build'
import { findDeployable } from './tomcat'

/** WEB-INF is never served, so the marker cannot leak through Tomcat. */
const stampFile = (exploded: string): string => join(exploded, 'WEB-INF', '.mixdog-deploy')

const BUILD_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']

async function buildFilesHash(projectDir: string): Promise<string> {
  const h = createHash('sha1')
  for (const f of BUILD_FILES) {
    try {
      h.update(f).update(await fs.readFile(join(projectDir, f)))
    } catch {
      /* not this tool */
    }
  }
  return h.digest('hex')
}

interface SyncCount {
  copied: number
  deleted: number
}

/**
 * Copy files of src that are missing / changed (size or newer mtime) in dest.
 * With prune, files in dest that no longer exist in src are deleted (stale classes).
 */
async function syncDir(src: string, dest: string, prune: boolean, n: SyncCount = { copied: 0, deleted: 0 }): Promise<SyncCount> {
  const entries = await fs.readdir(src, { withFileTypes: true }).catch(() => null)
  if (!entries) return n
  await fs.mkdir(dest, { recursive: true })
  const names = new Set<string>()
  await Promise.all(
    entries.map(async (e) => {
      names.add(e.name.toLowerCase())
      const s = join(src, e.name)
      const d = join(dest, e.name)
      if (e.isDirectory()) return void (await syncDir(s, d, prune, n))
      if (!e.isFile()) return
      const [ss, ds] = await Promise.all([fs.stat(s), fs.stat(d).catch(() => null)])
      if (ds && ds.size === ss.size && ds.mtimeMs >= ss.mtimeMs) return
      await fs.copyFile(s, d)
      n.copied++
    })
  )
  if (prune) {
    for (const e of await fs.readdir(dest, { withFileTypes: true })) {
      if (names.has(e.name.toLowerCase())) continue
      await fs.rm(join(dest, e.name), { recursive: true, force: true })
      n.deleted++
    }
  }
  return n
}

/**
 * Build for run. Returns false when the build failed.
 * Falls back to the normal build (fullGoals) when a fast deploy is not possible
 * (multi-module Maven, Gradle without an exploded folder).
 */
export async function fastBuild(projectDir: string, jdkHome: string | null, cfg: RunConfig, offline: boolean, fullGoals: string | null): Promise<boolean> {
  const info = await detectBuild(projectDir)
  if (!info.tool) return true
  const out = (line: string): void => {
    publish('build.output', { line: `[mixdog] ${line}`, stream: 'out' }, 'system', projectDir)
  }
  const full = (why: string): Promise<boolean> =>
    runBuild(projectDir, jdkHome, fullGoals, { offline, after: async () => out(`${why} → 전체 빌드로 실행했습니다`) })

  if (info.tool === 'maven') {
    const pom = await fs.readFile(join(projectDir, 'pom.xml'), 'utf-8').catch(() => '')
    if (/<modules>/.test(pom)) return full('여러 모듈 프로젝트는 빠른 빌드를 지원하지 않습니다')
    if (!/<packaging>\s*war\s*<\/packaging>/.test(pom)) return full('war 프로젝트가 아닙니다')
  }

  const found = cfg.deployPath || (await findDeployable(projectDir))
  const exploded = found && !found.toLowerCase().endsWith('.war') && existsSync(found) ? found : null
  const hash = await buildFilesHash(projectDir)
  const stamped = !!exploded && (await fs.readFile(stampFile(exploded), 'utf-8').catch(() => '')) === hash
  const started = Date.now()

  const sync = async (dir: string): Promise<void> => {
    const n: SyncCount = { copied: 0, deleted: 0 }
    const classes = join(dir, 'WEB-INF', 'classes')
    if (info.tool === 'maven') {
      await syncDir(join(projectDir, 'target', 'classes'), classes, true, n)
    } else {
      for (const c of ['classes/java/main', 'classes/kotlin/main', 'classes/groovy/main', 'resources/main']) {
        await syncDir(join(projectDir, 'build', ...c.split('/')), classes, false, n)
      }
    }
    await syncDir(join(projectDir, 'src', 'main', 'webapp'), dir, false, n)
    out(`바뀐 파일 ${n.copied}개 복사${n.deleted ? `, 지운 클래스 ${n.deleted}개` : ''} → ${basename(dir)} (${((Date.now() - started) / 1000).toFixed(1)}초)`)
  }

  if (info.tool === 'gradle') {
    if (!exploded) return full('exploded 배포 폴더가 없습니다 (Gradle 은 war 만 만듦)')
    return runBuild(projectDir, jdkHome, 'classes', { offline, label: '빠른 빌드', after: () => sync(exploded) })
  }

  if (!stamped) {
    // first run, after clean, or pom.xml changed: (re)create the exploded folder with WEB-INF/lib
    const why = !exploded ? '배포 폴더가 없어' : 'pom.xml 이 바뀌어'
    return runBuild(projectDir, jdkHome, 'compile war:exploded', {
      offline,
      label: '빠른 빌드 (배포 폴더 생성)',
      after: async () => {
        const dir = cfg.deployPath || (await findDeployable(projectDir))
        if (!dir || dir.toLowerCase().endsWith('.war')) throw new Error('war:exploded 후에도 배포 폴더를 찾지 못했습니다')
        await fs.writeFile(stampFile(dir), hash, 'utf-8')
        out(`${why} 배포 폴더를 새로 만들었습니다 (다음 실행부터는 바뀐 파일만 복사)`)
      }
    })
  }
  return runBuild(projectDir, jdkHome, 'compile', { offline, label: '빠른 빌드', after: () => sync(exploded!) })
}
