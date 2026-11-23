/** JDK discovery, download (Eclipse Temurin), and per-project version detection. */
import { promises as fs, existsSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { TOOLS_DIR, getTools } from '../core/settings'
import { installZip } from './download'

export interface JdkInfo {
  home: string
  /** major version: 8, 11, 17, 21 ... */
  major: number
  version: string
  vendor: string
  managed: boolean
}

export const JDK_DIR = join(TOOLS_DIR, 'jdks')

const SCAN_ROOTS = [
  'C:\\Program Files\\Java',
  'C:\\Program Files\\Eclipse Adoptium',
  'C:\\Program Files\\Eclipse Foundation',
  'C:\\Program Files\\Zulu',
  'C:\\Program Files\\Microsoft',
  'C:\\Program Files\\Amazon Corretto',
  'C:\\Program Files\\BellSoft',
  'C:\\Program Files\\OpenJDK',
  join(homedir(), '.jdks'), // IntelliJ downloads
  JDK_DIR
]

function parseMajor(v: string): number {
  // "1.8.0_301" -> 8, "17.0.18" -> 17, "21" -> 21
  const m = v.match(/^1\.(\d+)/) ?? v.match(/^(\d+)/)
  return m ? Number(m[1]) : 0
}

export async function inspectJdk(home: string): Promise<JdkInfo | null> {
  if (!existsSync(join(home, 'bin', 'javac.exe'))) return null // JRE only - can't compile
  let version = ''
  let vendor = ''
  try {
    const rel = await fs.readFile(join(home, 'release'), 'utf-8')
    version = rel.match(/^JAVA_VERSION="([^"]+)"/m)?.[1] ?? ''
    vendor = rel.match(/^IMPLEMENTOR="([^"]+)"/m)?.[1] ?? ''
  } catch {
    version = basename(home).replace(/^jdk-?/, '')
  }
  // Old Oracle JDKs write JAVA_VERSION="1.7.0" without the update; the folder (jdk1.7.0_80) has it.
  const folderVer = basename(home).match(/^jdk(1\.\d+\.\d+_\d+)$/)?.[1]
  if (folderVer && !version.includes('_')) version = folderVer
  if (!version) version = basename(home).replace(/^jdk-?/, '')
  return {
    home,
    major: parseMajor(version),
    version,
    vendor: vendor.replace('Oracle Corporation', 'Oracle'),
    managed: home.startsWith(JDK_DIR)
  }
}

export async function listJdks(): Promise<JdkInfo[]> {
  const candidates = new Set<string>()
  if (process.env['JAVA_HOME']) candidates.add(process.env['JAVA_HOME'])
  for (const extra of getTools().extraJdks) candidates.add(extra)
  for (const root of SCAN_ROOTS) {
    try {
      for (const d of await fs.readdir(root, { withFileTypes: true })) {
        if (d.isDirectory()) candidates.add(join(root, d.name))
      }
    } catch {
      /* root doesn't exist */
    }
  }
  const found = (await Promise.all([...candidates].map(inspectJdk))).filter((j): j is JdkInfo => !!j)
  // dedupe by real path, newest first
  const seen = new Set<string>()
  return found
    .filter((j) => {
      const k = j.home.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => b.major - a.major || b.version.localeCompare(a.version))
}

/** Download the latest Eclipse Temurin GA build of a feature release (17, 21, 25...). */
export async function downloadJdk(major: number): Promise<JdkInfo | null> {
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk`
  const home = await installZip(url, JDK_DIR, `JDK ${major} (Temurin)`)
  return inspectJdk(home)
}

/**
 * Guess the Java version a project targets from pom.xml / build.gradle.
 * Returns the major version or null when it can't tell.
 */
export async function detectProjectJava(projectDir: string): Promise<number | null> {
  const read = async (f: string): Promise<string> => {
    try {
      return await fs.readFile(join(projectDir, f), 'utf-8')
    } catch {
      return ''
    }
  }
  const pom = await read('pom.xml')
  if (pom) {
    const m =
      pom.match(/<maven\.compiler\.release>\s*([\d.]+)/) ??
      pom.match(/<java\.version>\s*([\d.]+)/) ??
      pom.match(/<maven\.compiler\.source>\s*([\d.]+)/) ??
      pom.match(/<release>\s*([\d.]+)\s*<\/release>/) ??
      pom.match(/<source>\s*([\d.]+)\s*<\/source>/)
    if (m) return parseMajor(m[1])
  }
  const gradle = (await read('build.gradle')) + (await read('build.gradle.kts'))
  if (gradle) {
    const m =
      gradle.match(/languageVersion\s*(?:=|\.set\()\s*JavaLanguageVersion\.of\(\s*(\d+)/) ??
      gradle.match(/JavaVersion\.VERSION_(\d+(?:_\d+)?)/) ??
      gradle.match(/sourceCompatibility\s*=\s*['"]?([\d.]+)/)
    if (m) return parseMajor(m[1].replace('_', '.'))
  }
  return null
}

/** Pick the best installed JDK for a target version: exact major, else the smallest newer one. */
export function pickJdk(jdks: JdkInfo[], target: number | null): JdkInfo | null {
  if (!jdks.length) return null
  if (!target) return jdks[0]
  return (
    jdks.find((j) => j.major === target) ??
    [...jdks].filter((j) => j.major > target).sort((a, b) => a.major - b.major)[0] ??
    jdks[0]
  )
}
