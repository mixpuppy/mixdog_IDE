<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch, defineAsyncComponent, ref } from 'vue'
import TitleBar from './components/TitleBar.vue'
import ActivityBar from './components/ActivityBar.vue'
import EditorArea from './components/EditorArea.vue'
import Dock from './components/tools/Dock.vue'
import ToolHost from './components/tools/ToolHost.vue'
import DropZones from './components/tools/DropZones.vue'
import { layout, toggleTool, showTool } from './layout'
import StatusBar from './components/StatusBar.vue'
import Toast from './components/Toast.vue'
import UiLayer from './components/UiLayer.vue'
import { goto, openGoto, openFind } from './search'
import { tasks } from './tasks'
import { branchPopup, toggleBranchPopup } from './git'
import { ai, sendSelectionToClaude } from './ai'
import { store, showPanel, setProject, setEditorHidden } from './store'
import { ide, loadProjectInfo } from './ide'
import { run } from './commands'
import { ui } from './ui'
import { dbg, resume, stepOver, stepInto, stepOut } from './debug'
import { mr } from './mr'
import { conflictUi } from './conflicts'
import './closeguard'
const BranchPopup = defineAsyncComponent(() => import('./components/git/BranchPopup.vue'))
const TaskList = defineAsyncComponent(() => import('./components/TaskList.vue'))
const GotoPopup = defineAsyncComponent(() => import('./components/GotoPopup.vue'))
const GitView = defineAsyncComponent(() => import('./components/git/GitView.vue'))
const AiPanel = defineAsyncComponent(() => import('./components/AiPanel.vue'))
const RunConfigDialog = defineAsyncComponent(() => import('./components/RunConfigDialog.vue'))
const ProjectSettingsDialog = defineAsyncComponent(() => import('./components/ProjectSettingsDialog.vue'))
const ConnectionDialog = defineAsyncComponent(() => import('./components/db/ConnectionDialog.vue'))
const MergeRequestDialog = defineAsyncComponent(() => import('./components/git/MergeRequestDialog.vue'))
const ConflictResolver = defineAsyncComponent(() => import('./components/git/ConflictResolver.vue'))

/** Claude panel: created the first time it is opened, then kept (its sessions live in it) */
const aiMounted = ref(ai.visible)
watch(() => ai.visible, (v) => v && (aiMounted.value = true))

window.api.initialProject().then((p) => p && setProject(p))
window.api.window.onFocus((f) => (store.windowFocused = f))
// the page's own focus too: if the window focus event from Windows never arrives, the UI still wakes up
window.addEventListener('focus', () => {
  if (!store.windowFocused) window.api.window.diag('focus-without-window-event')
  store.windowFocused = true
})
// a click while the page has no keyboard focus is the "nothing reacts" state: log it for diagnosis
window.addEventListener(
  'mousedown',
  () => {
    if (!document.hasFocus()) window.api.window.diag('click-without-focus', { windowFocused: store.windowFocused })
  },
  true
)
window.api.window.onState((s) => (store.maximized = s.maximized))

// Re-detect JDK / build tool / run config whenever the project changes.
watch(() => store.project?.path, () => loadProjectInfo())

/** Global shortcuts (IntelliJ Windows keymap). Editor-only keys live in CodeEditor. */
const KEYS: { match: (e: KeyboardEvent) => boolean; action: () => unknown }[] = [
  { match: (e) => e.altKey && !e.ctrlKey && e.key === '1', action: () => toggleTool('project') },
  { match: (e) => e.altKey && e.key === '9', action: () => { showTool('git'); store.mainView = 'git' } },
  {
    match: (e) => e.altKey && e.key === 'F12',
    action: () => toggleTool('terminal')
  },
  {
    // IntelliJ "Git Branches" popup
    match: (e) => e.ctrlKey && e.shiftKey && (e.key === '`' || e.key === '~' || e.code === 'Backquote'),
    action: () => {
      if (!store.project) return
      const btn = document.querySelector<HTMLElement>('[data-branch-trigger]')
      toggleBranchPopup(btn ? ({ currentTarget: btn } as unknown as MouseEvent) : undefined)
    }
  },
  // search (IntelliJ): Ctrl+Shift+N file, Ctrl+N class, Ctrl+E recent, Ctrl+Shift+F / R find / replace in path
  { match: (e) => e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n', action: () => openGoto('files') },
  { match: (e) => e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n', action: () => openGoto('classes') },
  { match: (e) => e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e', action: () => openGoto('recent') },
  { match: (e) => e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f', action: () => openFind(false) },
  { match: (e) => e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r', action: () => openFind(true) },
  { match: (e) => e.ctrlKey && !e.shiftKey && e.key === 'F4', action: () => run('file.close') },
  { match: (e) => e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's', action: () => run('file.save') },
  { match: (e) => e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'o', action: () => run('project.open') },
  { match: (e) => e.ctrlKey && e.key === 'F9', action: () => store.project && run('build.run') },
  { match: (e) => e.shiftKey && e.key === 'F10', action: () => store.project && run(ide.info?.settings.run.tomcatHome ? 'run.start' : 'settings.run') },
  { match: (e) => e.shiftKey && e.key === 'F9', action: () => store.project && run(ide.info?.settings.run.tomcatHome ? 'run.debug' : 'settings.run') },
  { match: (e) => e.ctrlKey && e.key === 'F2', action: () => run('run.stop') },
  // debugger (only while stopped at a breakpoint; the editor has the same keys)
  { match: (e) => dbg.paused && !e.ctrlKey && !e.shiftKey && e.key === 'F9', action: resume },
  { match: (e) => dbg.paused && !e.ctrlKey && !e.shiftKey && e.key === 'F8', action: stepOver },
  { match: (e) => dbg.paused && !e.ctrlKey && !e.shiftKey && e.key === 'F7', action: stepInto },
  { match: (e) => dbg.paused && !e.ctrlKey && e.shiftKey && e.key === 'F8', action: stepOut },
  { match: (e) => e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === 's', action: () => store.project && run('settings.project') },
  { match: (e) => e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a', action: () => (ai.visible = !ai.visible) },
  { match: (e) => e.ctrlKey && e.altKey && e.key.toLowerCase() === 'k', action: () => sendSelectionToClaude() },
  {
    match: (e) => e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm',
    action: () => {
      // Claude wide mode: hide the editor (and open Claude if it was closed)
      const hide = !(store.editorHidden && ai.visible)
      setEditorHidden(hide)
      if (hide) ai.visible = true
    }
  }
]

/* Shift pressed twice quickly (and nothing else) = Search Everywhere */
let lastShift = 0
let shiftClean = false
function onShift(e: KeyboardEvent): void {
  if (e.type === 'keydown') {
    shiftClean = e.key === 'Shift' && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey
    return
  }
  if (e.key !== 'Shift' || !shiftClean) return
  const now = Date.now()
  if (now - lastShift < 380) {
    lastShift = 0
    if (!store.dialog && !ui.ask && !ui.choice) openGoto('all')
  } else lastShift = now
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Shift') shiftClean = false
  if (goto.open) return
  if (store.dialog || ui.ask || ui.choice) return
  if (branchPopup.open && !(e.ctrlKey && e.shiftKey)) return
  const k = KEYS.find((k) => k.match(e))
  if (!k) return
  e.preventDefault()
  k.action()
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('keydown', onShift, true)
  window.addEventListener('keyup', onShift, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keydown', onShift, true)
  window.removeEventListener('keyup', onShift, true)
})
</script>

<template>
  <div class="app" :class="{ blurred: !store.windowFocused }">
    <TitleBar />
    <div class="body">
      <ActivityBar side="left" />
      <Dock v-show="layout.open.left && layout.docks.left.length" pos="left" />
      <main v-show="!(store.editorHidden && ai.visible)" class="main">
        <GitView v-if="store.mainView === 'git'" />
        <EditorArea v-show="store.mainView === 'editor'" />
        <Dock v-show="layout.open.bottom && layout.docks.bottom.length" pos="bottom" />
      </main>
      <Dock v-show="layout.open.right && layout.docks.right.length && !(store.editorHidden && ai.visible)" pos="right" />
      <AiPanel v-if="aiMounted" v-show="ai.visible" :class="{ fill: store.editorHidden }" />
      <ActivityBar v-if="layout.docks.right.length || layout.dragging" side="right" />
      <DropZones v-if="layout.dragging" />
    </div>
    <ToolHost />
    <StatusBar />
    <ProjectSettingsDialog v-if="store.dialog === 'project' && ide.info" />
    <RunConfigDialog v-if="store.dialog === 'run' && ide.info" />
    <ConnectionDialog v-if="store.dialog === 'db'" />
    <MergeRequestDialog v-if="mr.req && store.project" />
    <ConflictResolver v-if="conflictUi.open && store.project" />
    <Toast />
    <BranchPopup v-if="branchPopup.open" />
    <TaskList v-if="tasks.open" />
    <GotoPopup v-if="goto.open" />
    <UiLayer />
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
}
.editor-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
