/**
 * Before the window closes (close button, Alt+F4, quitting): ask about unsaved files, a running
 * Tomcat / build, and anything else a module registers (DB transactions...), one question at a time.
 * Cancel on any question keeps the window open.
 */
import { store, tabsOf } from './store'
import { docs } from './monaco'
import { ide } from './ide'
import { chooseSheet } from './ui'

export interface CloseStep {
  title: string
  message: string
  /** buttons; the last one is the main (blue) one */
  options: string[]
  /** run the chosen option (index into options) */
  run: (choice: number) => Promise<void>
}

const checks: (() => CloseStep | null)[] = []

/** other modules (db.ts) add their own question */
export function registerCloseCheck(fn: () => CloseStep | null): void {
  checks.push(fn)
}

function dirtyPaths(): string[] {
  const out = new Set<string>()
  for (const g of store.groups) for (const t of g.tabs) if (t.dirty) out.add(t.path)
  return [...out]
}

async function saveAll(paths: string[]): Promise<void> {
  for (const p of paths) {
    const doc = docs.get(p)
    if (!doc) continue
    await window.api.fs.writeFile(p, doc.model.getValue())
    doc.savedVersion = doc.model.getAlternativeVersionId()
    for (const t of tabsOf(p)) t.dirty = false
  }
}

/* unsaved files */
registerCloseCheck(() => {
  const paths = dirtyPaths()
  if (!paths.length) return null
  const names = paths.map((p) => p.split(/[\\/]/).pop()).slice(0, 8)
  return {
    title: '저장하지 않은 파일',
    message: `${names.join(', ')}${paths.length > 8 ? ` 외 ${paths.length - 8}개` : ''} 의 수정 내용이 저장되지 않았습니다.`,
    options: ['저장 안 함', '모두 저장'],
    run: async (i) => {
      if (i === 1) await saveAll(paths)
    }
  }
})

/* Tomcat / build of this window's project */
registerCloseCheck(() => {
  const p = store.project
  if (!p || (ide.tomcat === 'stopped' && !ide.building)) return null
  const parts: string[] = []
  if (ide.tomcat !== 'stopped') parts.push(`Tomcat 이 ${ide.tomcat === 'running' ? '실행 중' : '시작 중'}입니다${ide.appUrl ? ` (${ide.appUrl})` : ''}.`)
  if (ide.building) parts.push('빌드가 진행 중입니다.')
  return {
    title: '실행 중인 서버',
    message: `${parts.join(' ')}\nIDE 를 닫으면서 함께 종료할까요? (계속 실행하면 나중에 직접 종료해야 합니다)`,
    options: ['계속 실행', '종료하고 닫기'],
    run: async (i) => {
      if (i === 1) await window.api.run.stop(p.path).catch(() => {})
      else await window.api.run.keepOnQuit(p.path).catch(() => {})
    }
  }
})

let closing = false
let asking = false

window.addEventListener('beforeunload', (e) => {
  if (closing) return
  const steps = checks.map((c) => c()).filter((s): s is CloseStep => !!s)
  if (!steps.length) return
  e.preventDefault()
  e.returnValue = false
  if (asking) return
  asking = true
  void (async () => {
    try {
      for (const s of steps) {
        const i = await chooseSheet(s.title, s.message, s.options)
        if (i === null) return // cancelled: stay open
        await s.run(i)
      }
      closing = true
      window.api.window.close()
    } finally {
      asking = false
    }
  })()
})
