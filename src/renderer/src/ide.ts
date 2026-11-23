/**
 * Project-level IDE state: settings (JDK / build / run config), consoles,
 * run state and the event log. Fed by the main-process event bus.
 */
import { reactive } from 'vue'
import type { IdeEvent, ProjectInfo } from './types'
import { store, showPanel, reloadFromDisk } from './store'
import { setProblemMarkers, type Problem } from './problems'

export interface ConsoleLine {
  id: number
  text: string
  err: boolean
}

const MAX_LINES = 8000
let lineSeq = 0

export const ide = reactive({
  info: null as ProjectInfo | null,
  building: false,
  tomcat: 'stopped' as 'stopped' | 'starting' | 'running',
  appUrl: null as string | null,
  buildLines: [] as ConsoleLine[],
  tomcatLines: [] as ConsoleLine[],
  lastBuild: null as { ok: boolean; ms?: number } | null,
  events: [] as IdeEvent[],
  downloads: {} as Record<string, { pct: number; phase?: string }>,
  toast: null as { text: string; kind: 'info' | 'error' | 'ok' } | null,
  /** compiler errors / warnings of the last compile (Problems window, editor squiggles) */
  problems: [] as Problem[]
})

function push(list: ConsoleLine[], text: string, err = false): void {
  list.push({ id: ++lineSeq, text, err })
  if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES)
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  ide.toast = { text, kind }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (ide.toast = null), kind === 'error' ? 7000 : 3500)
}

export async function loadProjectInfo(): Promise<void> {
  if (!store.project) {
    ide.info = null
    setProblems([])
    return
  }
  void window.api.build.problems(store.project.path).then((l) => setProblems(l as unknown as Problem[]))
  ide.info = (await window.api.project.info(store.project.path, store.project.name)) as unknown as ProjectInfo
}

export function setProblems(list: Problem[]): void {
  ide.problems = list
  setProblemMarkers(list)
}

export async function saveSettings(): Promise<void> {
  if (!store.project || !ide.info) return
  await window.api.project.save(store.project.path, JSON.parse(JSON.stringify(ide.info.settings)))
  await loadProjectInfo()
}

/* ---------- event stream from main ---------- */
function onEvent(ev: IdeEvent): void {
  const d = ev.data
  switch (ev.type) {
    case 'build.start':
      ide.building = true
      ide.buildLines = []
      push(ide.buildLines, `▶ ${d.label ? `[${d.label}] ` : ''}${d.tool} ${d.goals}   (JDK: ${d.jdkHome ?? '시스템 기본'})`)
      showPanel('build')
      break
    case 'build.output':
      push(ide.buildLines, String(d.line), d.stream === 'err')
      return // don't flood the event list
    case 'build.end':
      ide.building = false
      ide.lastBuild = { ok: !!d.ok, ms: d.ms as number }
      push(ide.buildLines, d.ok ? `✔ 빌드 성공 (${((d.ms as number) / 1000).toFixed(1)}초)` : `✖ 빌드 실패 (exit ${d.code})`, !d.ok)
      {
        const errs = ide.problems.filter((p) => p.severity === 'error').length
        toast(d.ok ? '빌드 성공' : errs ? `빌드 실패 · 컴파일 오류 ${errs}건 (문제 창)` : '빌드 실패', d.ok ? 'ok' : 'error')
        if (!d.ok && errs) showPanel('problems')
      }
      break
    case 'build.problems':
      setProblems(d.problems as Problem[])
      break
    case 'tomcat.start':
      ide.tomcat = 'starting'
      ide.appUrl = String(d.url)
      ide.tomcatLines = []
      push(ide.tomcatLines, `▶ Tomcat ${d.version}${d.debug ? `  [디버그 포트 ${d.debugPort}]` : ''}`)
      push(ide.tomcatLines, `  배포: ${d.docBase}`)
      push(ide.tomcatLines, `  JDK: ${d.jdkHome}`)
      showPanel('tomcat')
      break
    case 'tomcat.output':
      push(ide.tomcatLines, String(d.line), d.stream === 'err' && /SEVERE|ERROR|Exception/.test(String(d.line)))
      return
    case 'tomcat.started':
      ide.tomcat = 'running'
      push(ide.tomcatLines, `✔ 실행됨 → ${d.url}`)
      toast(`Tomcat 실행됨: ${d.url}`, 'ok')
      break
    case 'tomcat.stop':
      ide.tomcat = 'stopped'
      push(ide.tomcatLines, `■ Tomcat 종료 (exit ${d.code})`)
      break
    case 'tomcat.sync':
      push(ide.tomcatLines, `↻ 반영됨: ${d.file}`)
      break
    case 'tomcat.error':
      toast(String(d.message), 'error')
      break
    case 'tools.download.start':
      ide.downloads[String(d.label)] = { pct: 0 }
      break
    case 'tools.download.progress':
      ide.downloads[String(d.label)] = { pct: Number(d.pct), phase: d.phase as string }
      return
    case 'tools.download.done':
      delete ide.downloads[String(d.label)]
      toast(`${d.label} 설치 완료`, 'ok')
      break
    case 'tools.download.error':
      delete ide.downloads[String(d.label)]
      toast(`${d.label} 다운로드 실패: ${d.error}`, 'error')
      break
    case 'error':
      toast(String(d.message), 'error')
      break
    case 'file.changed':
      reloadFromDisk(String(d.path)).then((r) => {
        if (r === 'dirty') toast(`${String(d.relative)} 이(가) 디스크에서 바뀌었지만, 저장하지 않은 수정이 있어 다시 불러오지 않았습니다.`, 'error')
      })
      break
  }
  ide.events.push(ev)
  if (ide.events.length > 2000) ide.events.splice(0, ide.events.length - 2000)
}

window.api.events.on((ev) => onEvent(ev as unknown as IdeEvent))
window.api.events.onStream((ev) => onEvent(ev as unknown as IdeEvent))

/** Report a UI action to the event bus. */
export function emit(type: string, data: Record<string, unknown> = {}, source = 'user'): void {
  window.api.events.emit(type, data, source)
}
