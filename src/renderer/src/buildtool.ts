/**
 * Maven / Gradle tool window state (IntelliJ style): pom.xml model (lifecycle, plugins,
 * profiles, dependencies, modules), Gradle task list, run options, and running goals.
 */
import { reactive, watch } from 'vue'
import { store } from './store'
import { ide, toast, saveSettings } from './ide'
import { titleOverride } from './layout'

export interface Dep {
  groupId: string
  artifactId: string
  version: string
  scope: string
  optional: boolean
}
export interface Plugin {
  groupId: string
  artifactId: string
  version: string
  prefix: string
  goals: string[]
}
export interface Pom {
  groupId: string
  artifactId: string
  version: string
  packaging: string
  name: string
  modules: string[]
  profiles: { id: string; activeByDefault: boolean }[]
  plugins: Plugin[]
  dependencies: Dep[]
}
export interface GradleGroup {
  name: string
  tasks: { name: string; desc: string }[]
}

export const LIFECYCLE = ['clean', 'validate', 'compile', 'test', 'package', 'verify', 'install', 'site', 'deploy']

/** common goals of well-known plugins (the plugin's own goals are not read from the jar) */
const KNOWN_GOALS: Record<string, string[]> = {
  clean: ['clean'],
  resources: ['resources', 'testResources'],
  compiler: ['compile', 'testCompile'],
  surefire: ['test'],
  failsafe: ['integration-test', 'verify'],
  jar: ['jar'],
  war: ['war', 'exploded'],
  install: ['install'],
  deploy: ['deploy'],
  dependency: ['tree', 'analyze', 'resolve', 'copy-dependencies', 'purge-local-repository'],
  help: ['effective-pom', 'describe'],
  'spring-boot': ['run', 'repackage', 'build-info'],
  tomcat7: ['run', 'deploy', 'redeploy', 'undeploy'],
  tomcat: ['run', 'deploy', 'redeploy'],
  jetty: ['run'],
  exec: ['java', 'exec'],
  antrun: ['run'],
  source: ['jar'],
  javadoc: ['javadoc', 'jar'],
  versions: ['display-dependency-updates', 'display-plugin-updates'],
  enforcer: ['enforce']
}
/** plugins every Maven project has (from the super POM / default lifecycle bindings) */
const DEFAULT_PLUGINS = ['clean', 'resources', 'compiler', 'surefire', 'install', 'deploy', 'dependency', 'help']

function prefixOf(artifactId: string): string {
  const m = artifactId.match(/^maven-(.+)-plugin$/) ?? artifactId.match(/^(.+)-maven-plugin$/)
  return m ? m[1] : artifactId
}

/* ---------------- pom.xml ---------------- */

const kids = (el: Element | null | undefined, tag: string): Element[] => (el ? [...el.children].filter((c) => c.localName === tag) : [])
const kid = (el: Element | null | undefined, tag: string): Element | undefined => kids(el, tag)[0]
const txt = (el: Element | null | undefined, tag: string): string => kid(el, tag)?.textContent?.trim() ?? ''

export function parsePom(xml: string): Pom {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('pom.xml 을 읽을 수 없습니다 (XML 형식 오류)')
  const root = doc.documentElement
  const parent = kid(root, 'parent')
  const props: Record<string, string> = {}
  for (const p of [...(kid(root, 'properties')?.children ?? [])]) props[p.localName] = p.textContent?.trim() ?? ''
  const version = txt(root, 'version') || txt(parent, 'version')
  const groupId = txt(root, 'groupId') || txt(parent, 'groupId')
  Object.assign(props, {
    'project.version': version,
    'project.groupId': groupId,
    'project.artifactId': txt(root, 'artifactId'),
    'pom.version': version
  })
  const sub = (s: string): string => s.replace(/\$\{([^}]+)\}/g, (m, k) => props[k] ?? m)

  const build = kid(root, 'build')
  const pluginEls = [...kids(kid(build, 'plugins'), 'plugin')]
  const declared: Plugin[] = pluginEls.map((p) => {
    const artifactId = txt(p, 'artifactId')
    const prefix = prefixOf(artifactId)
    const execGoals = kids(kid(p, 'executions'), 'execution').flatMap((e) => kids(kid(e, 'goals'), 'goal').map((g) => g.textContent?.trim() ?? ''))
    return {
      groupId: txt(p, 'groupId') || 'org.apache.maven.plugins',
      artifactId,
      version: sub(txt(p, 'version')),
      prefix,
      goals: [...new Set([...(KNOWN_GOALS[prefix] ?? []), ...execGoals.filter(Boolean)])]
    }
  })
  const packaging = txt(root, 'packaging') || 'jar'
  const defaults = [...DEFAULT_PLUGINS, packaging === 'war' ? 'war' : packaging === 'pom' ? '' : 'jar'].filter(Boolean)
  const plugins: Plugin[] = [
    ...defaults
      .filter((d) => !declared.some((p) => p.prefix === d))
      .map((d) => ({ groupId: 'org.apache.maven.plugins', artifactId: `maven-${d}-plugin`, version: '', prefix: d, goals: KNOWN_GOALS[d] ?? [] })),
    ...declared
  ].sort((a, b) => a.prefix.localeCompare(b.prefix))

  const dependencies: Dep[] = kids(kid(root, 'dependencies'), 'dependency').map((d) => ({
    groupId: sub(txt(d, 'groupId')),
    artifactId: sub(txt(d, 'artifactId')),
    version: sub(txt(d, 'version')),
    scope: txt(d, 'scope') || 'compile',
    optional: txt(d, 'optional') === 'true'
  }))

  return {
    groupId,
    artifactId: txt(root, 'artifactId'),
    version,
    packaging,
    name: txt(root, 'name'),
    modules: kids(kid(root, 'modules'), 'module').map((m) => m.textContent?.trim() ?? '').filter(Boolean),
    profiles: kids(kid(root, 'profiles'), 'profile').map((p) => ({
      id: txt(p, 'id'),
      activeByDefault: txt(kid(p, 'activation'), 'activeByDefault') === 'true'
    })),
    plugins,
    dependencies
  }
}

/* ---------------- gradle tasks ---------------- */

export function parseGradleTasks(out: string): GradleGroup[] {
  const lines = out.split(/\r?\n/)
  const groups: GradleGroup[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trim()
    // "Build tasks" followed by a line of dashes
    if (/^-{3,}$/.test(lines[i + 1]?.trim() ?? '') && /tasks$/i.test(head) && !/^All tasks runnable/i.test(head)) {
      const g: GradleGroup = { name: head.replace(/ tasks$/i, ''), tasks: [] }
      i += 2
      for (; i < lines.length && lines[i].trim(); i++) {
        const m = lines[i].match(/^(\S+)(?:\s+-\s+(.*))?$/)
        if (m) g.tasks.push({ name: m[1], desc: m[2] ?? '' })
      }
      if (g.tasks.length) groups.push(g)
    }
  }
  return groups
}

/* ---------------- state ---------------- */

const key = (k: string): string => `mixdog.buildtool.${k}:${store.project?.path.toLowerCase() ?? ''}`
function load<T>(k: string, def: T): T {
  try {
    const v = localStorage.getItem(key(k))
    return v === null ? def : (JSON.parse(v) as T)
  } catch {
    return def
  }
}
function save(k: string, v: unknown): void {
  try {
    localStorage.setItem(key(k), JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

export const bt = reactive({
  tool: null as 'maven' | 'gradle' | null,
  pom: null as Pom | null,
  error: null as string | null,
  gradle: [] as GradleGroup[],
  gradleLoading: false,
  offline: false,
  skipTests: false,
  /** selected Maven profiles */
  profiles: [] as string[],
  /** goals typed in "목표 실행", newest first */
  history: [] as string[],
  /** collapsed tree nodes */
  collapsed: {} as Record<string, boolean>,
  selected: null as string | null
})

/** (re)read pom.xml / remember options per project */
export async function reloadModel(): Promise<void> {
  const p = store.project
  bt.error = null
  bt.pom = null
  bt.tool = (ide.info?.build.tool ?? null) as 'maven' | 'gradle' | null
  titleOverride.buildtool = bt.tool === 'gradle' ? 'Gradle' : 'Maven'
  if (!p || !bt.tool) return
  if (bt.tool === 'maven') {
    try {
      bt.pom = parsePom(await window.api.fs.readFile(`${p.path}\\pom.xml`))
    } catch (e) {
      bt.error = e instanceof Error ? e.message : String(e)
    }
  } else if (!bt.gradle.length) {
    bt.gradle = load<GradleGroup[]>('gradleTasks', [])
  }
}

watch(
  () => [store.project?.path, ide.info?.build.tool],
  () => {
    bt.skipTests = load('skipTests', false)
    bt.profiles = load('profiles', [] as string[])
    bt.history = load('history', [] as string[])
    bt.collapsed = load('collapsed', { deps: true, plugins: false } as Record<string, boolean>)
    bt.gradle = []
    reloadModel()
  },
  { immediate: true }
)
// offline is a project setting (settings.json): it also applies to Ctrl+F9 and the build before Run
watch(() => ide.info?.settings.offline, (v) => (bt.offline = !!v), { immediate: true })
watch(() => bt.offline, async (v) => {
  if (!ide.info || ide.info.settings.offline === v) return
  ide.info.settings.offline = v
  await saveSettings()
})
watch(() => [bt.skipTests, bt.profiles, bt.collapsed], () => {
  save('skipTests', bt.skipTests)
  save('profiles', bt.profiles)
  save('collapsed', bt.collapsed)
}, { deep: true })

// pom.xml / build.gradle edited (by the user, Claude or git): reload the model
window.api.events.on((ev) => {
  const e = ev as { type: string; data: Record<string, unknown> }
  if ((e.type === 'file.save' || e.type === 'file.changed') && /(^|[\\/])(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/i.test(String(e.data.path ?? ''))) reloadModel()
})

export async function loadGradleTasks(): Promise<void> {
  if (!store.project) return
  bt.gradleLoading = true
  try {
    bt.gradle = parseGradleTasks(await window.api.build.gradleTasks(store.project.path, store.project.name))
    save('gradleTasks', bt.gradle)
    if (!bt.gradle.length) toast('Gradle 작업을 찾지 못했습니다', 'error')
  } catch {
    /* error toast comes from the main process */
  } finally {
    bt.gradleLoading = false
  }
}

/** goals + the toggles (skip tests / profiles / module) as one command line; offline is added by the main process */
export function commandFor(goals: string, module?: string): string {
  const parts = [goals.trim()]
  if (bt.tool === 'maven') {
    if (module) parts.push('-pl', module, '-am')
    if (bt.profiles.length) parts.push('-P', bt.profiles.join(','))
    if (bt.skipTests && !/\b-DskipTests\b/.test(goals)) parts.push('-DskipTests')
  } else {
    if (bt.skipTests && !/-x test\b/.test(goals)) parts.push('-x', 'test')
  }
  return parts.join(' ')
}

export async function runGoals(goals: string, module?: string): Promise<void> {
  if (!store.project) return
  if (ide.building) return toast('이미 빌드가 진행 중입니다', 'error')
  const cmd = commandFor(goals, module)
  try {
    await window.api.build.goals(store.project.path, store.project.name, cmd)
  } catch {
    /* error toast comes from the main process */
  }
}

export async function updateDeps(): Promise<void> {
  if (!store.project) return
  if (ide.building) return toast('이미 빌드가 진행 중입니다', 'error')
  try {
    const ok = await window.api.build.updateDeps(store.project.path, store.project.name)
    toast(ok ? '의존성을 업데이트했습니다' : '의존성 업데이트 실패 (빌드 창 확인)', ok ? 'ok' : 'error')
  } catch {
    /* error toast comes from the main process */
  }
  await reloadModel()
}

export function remember(goals: string): void {
  bt.history = [goals, ...bt.history.filter((g) => g !== goals)].slice(0, 15)
  save('history', bt.history)
}
