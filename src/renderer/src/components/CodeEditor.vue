<script setup lang="ts">
/**
 * One Monaco editor for one editor group. Groups share the document models, so the same
 * file open in two panes stays in sync; each pane keeps its own scroll / cursor per file.
 */
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import { monaco, docs, currentTheme, editorRef, externalReload } from '../monaco'
import { store, saveActive, closeTab, tabsOf } from '../store'
import { sendSelectionToClaude } from '../ai'
import { openMenu } from '../ui'
import { dbg, canBreak, toggleBreakpoint, bpAt, editCondition, setEnabled, removeBreakpoint, trackEdits, resume, stepOver, stepInto, stepOut } from '../debug'

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
  // breakpoint gutter only for Java / Kotlin
  editor.updateOptions({ glyphMargin: canBreak(path) })
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
  // Ctrl+click / F12 (text rules in the main process, loaded with the first editor)
  void import('../navigation').then((m) => m.registerNavigation())
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
  // Ctrl+Enter: run the SQL statement under the caret (.sql files); elsewhere Monaco's "insert line below"
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    const p = group.value?.activePath
    if (editor && p && /\.sql$/i.test(p)) void import('../db').then((m) => m.runFromEditor(editor!, p))
    else editor?.trigger('kb', 'editor.action.insertLineAfter', null)
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyR, () => editor?.trigger('kb', 'editor.action.startFindReplaceAction', null))
  // IntelliJ: Ctrl+B = go to declaration (Ctrl+click / F12 also work)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => editor?.trigger('kb', 'editor.action.revealDefinition', null))
  // debugger (IntelliJ keys): Ctrl+F8 breakpoint · F9 resume · F8 over · F7 into · Shift+F8 out
  const paused = editor.createContextKey<boolean>('mixdogDebugPaused', false)
  watch(
    () => dbg.paused,
    (v) => paused.set(v)
  )
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F8, () => {
    const pos = editor?.getPosition()
    if (shownPath && pos && canBreak(shownPath)) toggleBreakpoint(shownPath, pos.lineNumber)
  })
  editor.addCommand(monaco.KeyCode.F9, () => resume(), 'mixdogDebugPaused')
  editor.addCommand(monaco.KeyCode.F8, () => stepOver(), 'mixdogDebugPaused')
  editor.addCommand(monaco.KeyCode.F7, () => stepInto(), 'mixdogDebugPaused')
  editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F8, () => stepOut(), 'mixdogDebugPaused')
  // click in the gutter left of the line numbers: breakpoint · right click: condition / disable / remove
  const GLYPH = monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
  editor.onMouseDown((e) => {
    if (e.target.type !== GLYPH || !e.target.position || !shownPath || !canBreak(shownPath)) return
    if (e.event.rightButton) return
    toggleBreakpoint(shownPath, e.target.position.lineNumber)
  })
  editor.onContextMenu((e) => {
    if (e.target.type !== GLYPH || !e.target.position || !shownPath || !canBreak(shownPath)) return
    const path = shownPath
    const line = e.target.position.lineNumber
    const bp = bpAt(path, line)
    e.event.preventDefault()
    e.event.stopPropagation()
    openMenu(e.event.browserEvent, [
      bp ? { label: '중단점 삭제', action: () => removeBreakpoint(bp) } : { label: '중단점 추가', action: () => toggleBreakpoint(path, line) },
      { label: bp?.condition ? '조건 수정…' : '조건 넣기…', action: () => editCondition(path, line) },
      ...(bp ? [{ label: bp.enabled ? '사용 안 함' : '사용', action: () => setEnabled(bp, !bp.enabled) }] : [])
    ])
  })

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
    const m = editor?.getModel()
    if (m && canBreak(shownPath)) trackEdits(m)
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
