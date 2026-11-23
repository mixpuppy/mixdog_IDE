/**
 * Command registry.
 *
 * Every action a user can take is registered here with an id, a description
 * and a handler. Buttons, shortcuts, the main process and (later) the AI agent
 * all call `run(id, args)`, and every call is published as a `command` event,
 * so the AI can both see and repeat anything the user does.
 */
import { store, openFile, closeTab, saveActive, openFolder, openFolderInNewWindow, showPanel, splitTab, unsplit } from './store'
import { ide, emit, toast, loadProjectInfo } from './ide'
import { docs, editorRef } from './monaco'
import { layout, moveTool, resetLayout, TOOLS, type DockId, type ToolId } from './layout'

export interface Command {
  id: string
  title: string
  /** short description for the AI tool list */
  description: string
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

const registry = new Map<string, Command>()

export function register(cmd: Command): void {
  registry.set(cmd.id, cmd)
}

export function listCommands(): Pick<Command, 'id' | 'title' | 'description'>[] {
  return [...registry.values()].map(({ id, title, description }) => ({ id, title, description }))
}

export async function run(id: string, args: Record<string, unknown> = {}, source = 'user'): Promise<unknown> {
  const cmd = registry.get(id)
  if (!cmd) throw new Error(`알 수 없는 명령: ${id}`)
  emit('command', { id, args }, source)
  return cmd.run(args)
}

/** Main process / AI → renderer command calls */
window.api.commands.onInvoke(async ({ reqId, id, args, source }) => {
  try {
    const value = await run(id, (args ?? {}) as Record<string, unknown>, source)
    // plain JSON copy: Vue reactive proxies can't be structured-cloned over IPC
    window.api.commands.reply(reqId, true, value === undefined ? null : JSON.parse(JSON.stringify(value)))
  } catch (e) {
    window.api.commands.reply(reqId, false, undefined, e instanceof Error ? e.message : String(e))
  }
})

const project = (): { path: string; name: string } => {
  if (!store.project) throw new Error('열린 프로젝트가 없습니다')
  return store.project
}

async function guard(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn()
  } catch (e) {
    // IPC errors were already published by main (and toasted via the event); surface local ones only
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.startsWith('Error invoking remote method')) toast(msg, 'error')
    return null
  }
}

/* ---------------- built-in commands ---------------- */

register({ id: 'commands.list', title: '명령 목록', description: 'List all IDE commands', run: () => listCommands() })
register({ id: 'project.open', title: '폴더 열기', description: 'Show a folder picker and open it as the project', run: () => openFolder() })
register({
  id: 'project.openNewWindow',
  title: '새 창에서 폴더 열기',
  description: 'Open a folder (args.path, or a folder picker) in a new IDE window',
  run: (a) => (a.path ? window.api.newWindow(String(a.path)) : openFolderInNewWindow())
})
register({ id: 'window.new', title: '새 창', description: 'Open an empty new IDE window', run: () => window.api.newWindow(null) })
register({
  id: 'file.open',
  title: '파일 열기',
  description: 'Open a file in the editor. args: { path }',
  run: (a) => openFile(String(a.path))
})
register({ id: 'file.save', title: '저장', description: 'Save the active editor', run: () => saveActive() })
register({
  id: 'file.close',
  title: '탭 닫기',
  description: 'Close an editor tab. args: { path? } (default: active)',
  run: (a) => {
    const p = (a.path as string) ?? store.activePath
    if (p) closeTab(p)
  }
})
register({
  id: 'editor.getText',
  title: '에디터 내용 가져오기',
  description: 'Return the current text of an open file. args: { path? }',
  run: (a) => docs.get((a.path as string) ?? store.activePath ?? '')?.model.getValue() ?? null
})
register({
  id: 'ide.state',
  title: 'IDE 상태',
  description: 'Project, open tabs (with unsaved flags), active file, cursor and selection',
  run: () => {
    const ed = editorRef.current
    const sel = ed?.getSelection()
    const model = ed?.getModel()
    const selectedText = sel && model && !sel.isEmpty() ? model.getValueInRange(sel) : null
    return {
      project: store.project,
      activeFile: store.activePath,
      cursor: { ...store.cursor },
      selection: sel && !sel.isEmpty()
        ? { startLine: sel.startLineNumber, endLine: sel.endLineNumber, text: selectedText?.slice(0, 20000) }
        : null,
      openTabs: store.groups.flatMap((g) => g.tabs.map((t) => ({ path: t.path, unsaved: t.dirty }))).filter((t, i, a) => a.findIndex((x) => x.path === t.path) === i),
      editorPanes: store.groups.map((g, i) => ({ pane: i + 1, activeFile: g.activePath, tabs: g.tabs.map((t) => t.path), focused: i === store.activeGroup })),
      toolWindows: (['left', 'right', 'bottom'] as const).map((d) => ({ dock: d, tools: layout.docks[d], visible: layout.open[d] ? layout.active[d] : null })),
      jdk: ide.info?.jdk ?? null,
      buildTool: ide.info?.build.tool ?? null,
      tomcat: { state: ide.tomcat, url: ide.appUrl, version: ide.info?.tomcat?.version ?? null },
      building: ide.building,
      lastBuild: ide.lastBuild
    }
  }
})
register({
  id: 'editor.goto',
  title: '위치로 이동',
  description: 'Open a file and move the cursor to a line. args: { path, line, column? }',
  run: async (a) => {
    await openFile(String(a.path))
    const ed = editorRef.current
    const line = Number(a.line) || 1
    ed?.revealLineInCenter(line)
    ed?.setPosition({ lineNumber: line, column: Number(a.column) || 1 })
    ed?.focus()
  }
})
register({
  id: 'console.tail',
  title: '콘솔 출력',
  description: 'Last lines of the build or Tomcat console. args: { which: "build" | "tomcat", lines? }',
  run: (a) => {
    const lines = a.which === 'tomcat' ? ide.tomcatLines : ide.buildLines
    return lines.slice(-(Number(a.lines) || 200)).map((l) => l.text).join('\n')
  }
})
register({
  id: 'build.run',
  title: '빌드',
  description: 'Build the project with Maven or Gradle using the project JDK',
  run: () => guard(() => window.api.build.run(project().path, project().name))
})
register({ id: 'build.stop', title: '빌드 중지', description: 'Cancel the running build', run: () => store.project && window.api.build.stop(store.project.path) })
register({
  id: 'run.start',
  title: 'Tomcat 실행',
  description: 'Build (if configured) and start Tomcat with the project run configuration',
  run: () => guard(() => window.api.run.start(project().path, project().name, false))
})
register({
  id: 'run.debug',
  title: 'Tomcat 디버그',
  description: 'Like run.start but with JPDA debug port open',
  run: () => guard(() => window.api.run.start(project().path, project().name, true))
})
register({ id: 'run.stop', title: '중지', description: 'Stop build and Tomcat', run: () => store.project && window.api.run.stop(store.project.path) })
register({
  id: 'run.openBrowser',
  title: '브라우저에서 열기',
  description: 'Open the running web app in the default browser',
  run: () => ide.appUrl && window.api.openExternal(ide.appUrl)
})
register({ id: 'view.terminal', title: '터미널', description: 'Show the terminal panel', run: () => showPanel('terminal') })
register({ id: 'view.events', title: '이벤트 로그', description: 'Show the IDE event log panel', run: () => showPanel('events') })
register({
  id: 'settings.project',
  title: '프로젝트 설정',
  description: 'Open project settings (JDK, build tool)',
  run: () => (store.dialog = 'project')
})
register({
  id: 'settings.run',
  title: '실행 구성',
  description: 'Open the Tomcat run configuration',
  run: () => (store.dialog = 'run')
})
register({ id: 'project.reload', title: '프로젝트 정보 새로고침', description: 'Re-detect JDK / build tool', run: () => loadProjectInfo() })

/* ---------------- Git ---------------- */
import * as G from './git'
import { typeToClaude } from './ai'

register({
  id: 'git.show',
  title: 'Git 화면',
  description: 'Show the Git view (commit graph, branches, changes)',
  run: () => G.showGitView()
})
register({
  id: 'git.state',
  title: 'Git 상태',
  description: 'Current branch, upstream, ahead/behind, staged / unstaged / conflicted files, merge state, the commit message box',
  run: async () => {
    await G.refresh(false)
    return { status: G.git.status, commitMessage: G.git.commitMsg, selected: G.git.selected }
  }
})
register({
  id: 'git.setCommitMessage',
  title: '커밋 메시지 입력',
  description: 'Put text into the IDE commit message box (does not commit). args: { message }',
  run: (a) => {
    G.git.commitMsg = String(a.message ?? '')
    G.showGitView()
    G.select(G.WIP)
  }
})
register({
  id: 'git.askClaudeMessage',
  title: 'Claude 에게 커밋 메시지 부탁',
  description: 'Type a request into the active Claude tab to draft a commit message for the staged changes',
  run: () => {
    const n = G.git.status?.staged.length ?? 0
    const what = n ? '스테이지된 변경(git diff --cached)' : '작업 중인 변경(git diff)'
    const ok = typeToClaude(
      `${what}을 보고 커밋 메시지를 한국어로 작성해서 mcp__mixdog__run_ide_command 로 git.setCommitMessage 를 호출해 IDE 커밋 입력창에 넣어줘. 커밋은 하지 마.`
    )
    if (!ok) toast('먼저 Claude 세션을 여세요', 'error')
  }
})
register({ id: 'git.refresh', title: 'Git 새로고침', description: 'Reload git status, branches and the graph', run: () => G.refresh() })
register({ id: 'git.fetch', title: 'Fetch', description: 'git fetch --all --prune', run: () => G.fetchAll() })
register({ id: 'git.pull', title: 'Pull', description: 'git pull (current branch)', run: () => G.pull() })
register({ id: 'git.push', title: 'Push', description: 'git push (sets upstream on first push)', run: () => G.push() })
register({ id: 'git.newBranch', title: '새 브랜치', description: 'Ask for a name and create a branch at HEAD', run: () => G.newBranch() })
register({ id: 'git.stash', title: 'Stash', description: 'Stash working changes (asks for a message)', run: () => G.stashPush() })

/* ---------------- tool window layout ---------------- */
register({
  id: 'view.moveTool',
  title: '도구 창 옮기기',
  description: `Move a tool window to another dock. args: { tool: ${Object.keys(TOOLS).join('|')}, dock: left|right|bottom }`,
  run: (a) => moveTool(String(a.tool) as ToolId, String(a.dock) as DockId)
})
register({ id: 'view.resetLayout', title: '창 배치 초기화', description: 'Put every tool window back in its default place', run: () => resetLayout() })

/* ---------------- editor split ---------------- */
register({
  id: 'editor.splitRight',
  title: '오른쪽으로 분할',
  description: 'Open the active file (or args.path) in a new editor pane on the right',
  run: async (a) => {
    if (a.path) await openFile(String(a.path))
    if (store.activePath) splitTab(store.activePath, 'row')
  }
})
register({
  id: 'editor.splitDown',
  title: '아래로 분할',
  description: 'Open the active file (or args.path) in a new editor pane below',
  run: async (a) => {
    if (a.path) await openFile(String(a.path))
    if (store.activePath) splitTab(store.activePath, 'column')
  }
})
register({ id: 'editor.unsplit', title: '분할 해제', description: 'Merge all editor panes back into one', run: () => unsplit() })

/* ---------------- search ---------------- */
import { openGoto, openFind, find as findState, runFind } from './search'

register({ id: 'search.everywhere', title: '어디서나 찾기', description: 'Open Search Everywhere (files, classes, actions)', run: () => openGoto('all') })
register({ id: 'search.file', title: '파일 찾기', description: 'Open the Go to File popup', run: () => openGoto('files') })
register({ id: 'search.class', title: '클래스 찾기', description: 'Open the Go to Class popup', run: () => openGoto('classes') })
register({ id: 'search.recent', title: '최근 파일', description: 'Open the recent files popup', run: () => openGoto('recent') })
register({
  id: 'search.findInPath',
  title: '프로젝트에서 찾기',
  description: 'Show Find in Path with a query and return the matches shown to the user. args: { query, regex?, caseSensitive?, wholeWord?, mask? }',
  run: async (a) => {
    if (a.query !== undefined) findState.query = String(a.query)
    if (a.regex !== undefined) findState.regex = !!a.regex
    if (a.caseSensitive !== undefined) findState.caseSensitive = !!a.caseSensitive
    if (a.wholeWord !== undefined) findState.wholeWord = !!a.wholeWord
    if (a.mask !== undefined) findState.mask = String(a.mask)
    openFind(false)
    await runFind()
    return { total: findState.total, files: findState.results.map((f) => ({ file: f.rel, lines: f.matches.map((m) => m.line) })) }
  }
})

/* ---------------- Maven / Gradle tool window ---------------- */
import { runGoals as btRun, updateDeps as btUpdate } from './buildtool'
import { showTool } from './layout'

register({ id: 'buildtool.show', title: 'Maven/Gradle 창', description: 'Show the Maven / Gradle tool window', run: () => showTool('buildtool') })
register({
  id: 'buildtool.run',
  title: 'Maven/Gradle 목표 실행',
  description: 'Run Maven goals or Gradle tasks with the project JDK (offline / skip-tests / profile toggles of the tool window apply). args: { goals: "clean install", module? }',
  run: (a) => btRun(String(a.goals ?? ''), a.module ? String(a.module) : undefined)
})
register({ id: 'buildtool.updateDeps', title: '의존성 업데이트', description: 'Re-resolve dependencies and check remote repositories for updates (mvn -U / gradle --refresh-dependencies)', run: () => btUpdate() })
