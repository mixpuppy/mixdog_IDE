<script setup lang="ts">
/**
 * One Monaco editor for one editor group. Groups share the document models, so the same
 * file open in two panes stays in sync; each pane keeps its own scroll / cursor per file.
 */
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import { monaco, docs, currentTheme, editorRef, externalReload } from '../monaco'
import { store, saveActive, closeTab, tabsOf } from '../store'
import { sendSelectionToClaude } from '../ai'

const props = defineProps<{ groupId: number }>()
const group = computed(() => store.groups.find((g) => g.id === props.groupId))
const index = (): number => store.groups.findIndex((g) => g.id === props.groupId)

const host = ref<HTMLDivElement>()
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let shownPath: string | null = null
/** per-pane view state (scroll, cursor, folding) for each file shown here */
const views = new Map<string, monaco.editor.ICodeEditorViewState | null>()

function syncDirty(path: string): void {
  const doc = docs.get(path)
  if (!doc) return
  const dirty = doc.model.getAlternativeVersionId() !== doc.savedVersion
  for (const t of tabsOf(path)) t.dirty = dirty
}

/** status bar info follows the focused pane */
function report(): void {
  const model = editor?.getModel()
  if (!editor || !model) return
  store.language = model.getLanguageId()
  store.eol = model.getEOL() === '\r\n' ? 'CRLF' : 'LF'
  const pos = editor.getPosition()
  if (pos) store.cursor = { line: pos.lineNumber, col: pos.column }
}

function show(path: string | null): void {
  if (!editor) return
  if (shownPath && docs.has(shownPath)) views.set(shownPath, editor.saveViewState())
  shownPath = path
  const doc = path ? docs.get(path) : undefined
  editor.setModel(doc?.model ?? null)
  if (doc) {
    const v = (path && views.get(path)) ?? doc.viewState
    if (v) editor.restoreViewState(v)
    if (index() === store.activeGroup) {
      report()
      editor.focus()
    }
  }
}

onMounted(() => {
  editor = monaco.editor.create(host.value!, {
    model: null,
    theme: currentTheme(),
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', 'D2Coding', 'Cascadia Code', Consolas, monospace",
    fontSize: 13.5,
    lineHeight: 21,
    fontLigatures: true,
    minimap: { enabled: false },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    renderLineHighlight: 'all',
    roundedSelection: true,
    padding: { top: 10 },
    scrollBeyondLastLine: false,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    stickyScroll: { enabled: true },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    tabSize: 4,
    insertSpaces: true
  })

  if (index() === store.activeGroup) editorRef.current = editor

  // the focused pane is the active group (commands, Claude, status bar use it)
  editor.onDidFocusEditorWidget(() => {
    const i = index()
    if (i >= 0) store.activeGroup = i
    editorRef.current = editor
    report()
  })

  editor.addAction({
    id: 'mixdog.claude.mention',
    label: 'Claude 에게 보내기 (파일·선택 줄)',
    contextMenuGroupId: '0_claude',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyK],
    run: () => sendSelectionToClaude()
  })

  // IntelliJ-ish keys (Windows keymap)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive())
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD, () => editor?.trigger('kb', 'editor.action.copyLinesDownAction', null))
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => editor?.trigger('kb', 'editor.action.deleteLines', null))
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F4, () => {
    if (group.value?.activePath) closeTab(group.value.activePath, index())
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyR, () => editor?.trigger('kb', 'editor.action.startFindReplaceAction', null))
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL, () =>
    editor?.trigger('kb', 'editor.action.formatDocument', null)
  )

  // Report edits to the event bus, batched per file (what the AI "sees" the user typing).
  let pending: { path: string; changes: number; lines: Set<number> } | null = null
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    if (pending) {
      window.api.events.emit('editor.edit', {
        path: pending.path,
        changes: pending.changes,
        lines: [...pending.lines].sort((a, b) => a - b).slice(0, 50)
      })
    }
    pending = null
  }
  editor.onDidChangeModelContent((e) => {
    if (!shownPath) return
    syncDirty(shownPath)
    if (externalReload.active) return // disk reload (Claude / git), already logged as file.changed
    // the same model can be shown in two panes: only the focused one reports the typing
    if (!editor?.hasTextFocus()) return
    if (pending && pending.path !== shownPath) flush()
    pending ??= { path: shownPath, changes: 0, lines: new Set() }
    pending.changes += e.changes.length
    for (const c of e.changes) pending.lines.add(c.range.startLineNumber)
    clearTimeout(flushTimer)
    flushTimer = setTimeout(flush, 1500)
  })
  editor.onDidChangeCursorPosition((e) => {
    if (index() === store.activeGroup) store.cursor = { line: e.position.lineNumber, col: e.position.column }
  })

  show(group.value?.activePath ?? null)
})

watch(() => group.value?.activePath ?? null, show)
// keep editorRef on the active group's editor (e.g. after clicking a tab in another pane)
watch(
  () => store.activeGroup,
  () => {
    if (index() === store.activeGroup && editor) {
      editorRef.current = editor
      report()
    }
  }
)

onBeforeUnmount(() => {
  if (shownPath && docs.has(shownPath)) docs.get(shownPath)!.viewState = editor?.saveViewState() ?? null
  if (editorRef.current === editor) editorRef.current = null
  editor?.setModel(null) // the model belongs to the document, not to this pane
  editor?.dispose()
})
</script>

<template>
  <div ref="host" class="editor" />
</template>

<style scoped>
.editor {
  flex: 1;
  min-height: 0;
  background: var(--surface);
}
</style>
