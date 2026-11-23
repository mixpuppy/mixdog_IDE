/**
 * Persistent settings in %APPDATA%/mixdog-ide/settings.json.
 * Per-project settings are keyed by the project folder path, so nothing is
 * written into the user's repository.
 */
import { app } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

export interface RunConfig {
  tomcatHome: string | null
  contextPath: string
  httpPort: number
  debugPort: number
  buildBeforeRun: boolean
  /**
   * IntelliJ-style fast deploy before run: incremental compile + copy only changed
   * classes / web files into the exploded folder (no clean, no .war). false = run the
   * project's build goals (e.g. clean package) like before.
   */
  fastBuild: boolean
  /** Exploded webapp dir or .war; null = auto-detect from target/ or build/ */
  deployPath: string | null
  vmOptions: string
}

export interface ProjectSettings {
  jdkHome: string | null
  buildGoals: string | null
  /** Maven -o / Gradle --offline for every build (retried online when an artifact is missing) */
  offline: boolean
  run: RunConfig
}

interface SettingsFile {
  projects: Record<string, ProjectSettings>
  tools: { mavenHome: string | null; extraJdks: string[]; extraTomcats: string[] }
}

/** IDE-managed tools live here: ~/.mixdog/{jdks,maven,tomcat} */
export const TOOLS_DIR = join(homedir(), '.mixdog')

/** Shared by the installed app and the dev build (which has its own userData profile). */
const dir = (): string => join(app.getPath('appData'), 'mixdog-ide')
const file = (): string => join(dir(), 'settings.json')

let cache: SettingsFile | null = null

function load(): SettingsFile {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(file(), 'utf-8'))
  } catch {
    cache = null
  }
  cache ??= { projects: {}, tools: { mavenHome: null, extraJdks: [], extraTomcats: [] } }
  cache.tools ??= { mavenHome: null, extraJdks: [], extraTomcats: [] }
  cache.projects ??= {}
  return cache
}

/** Another IDE process (dev build, second install) may have written meanwhile: re-read before changing. */
function fresh(): SettingsFile {
  cache = null
  return load()
}

function save(): void {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(file(), JSON.stringify(load(), null, 2), 'utf-8')
}

export function defaultRunConfig(projectName: string): RunConfig {
  return {
    tomcatHome: null,
    contextPath: '/' + projectName,
    httpPort: 8080,
    debugPort: 5005,
    buildBeforeRun: true,
    fastBuild: true,
    deployPath: null,
    vmOptions: '-Xms256m -Xmx1024m'
  }
}

export function getProject(path: string, name: string): ProjectSettings {
  const s = fresh()
  const p = s.projects[path] ?? { jdkHome: null, buildGoals: null, offline: false, run: defaultRunConfig(name) }
  p.offline ??= false
  p.run = { ...defaultRunConfig(name), ...p.run }
  return p
}

export function setProject(path: string, value: ProjectSettings): void {
  fresh().projects[path] = value
  save()
}

export function getTools(): SettingsFile['tools'] {
  return fresh().tools
}

export function setTools(patch: Partial<SettingsFile['tools']>): void {
  Object.assign(fresh().tools, patch)
  save()
}
