import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}

monaco.editor.defineTheme('mixdog-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'FF7AB2' },
    { token: 'string', foreground: 'FC6A5D' },
    { token: 'number', foreground: 'D0BF69' },
    { token: 'comment', foreground: '7F8C98', fontStyle: 'italic' },
    { token: 'type', foreground: '5DD8FF' },
    { token: 'annotation', foreground: 'FD8F3F' },
    { token: 'tag', foreground: 'FF7AB2' },
    { token: 'attribute.name', foreground: 'D0A8FF' }
  ],
  colors: {
    'editor.background': '#1E1E20',
    'editor.lineHighlightBackground': '#2A2A2E',
    'editorLineNumber.foreground': '#5A5A60',
    'editorLineNumber.activeForeground': '#C8C8CC',
    'editor.selectionBackground': '#3F638B99',
    'editorIndentGuide.background1': '#2E2E33',
    'editorCursor.foreground': '#F5F5F7',
    'scrollbarSlider.background': '#FFFFFF1A',
    'scrollbarSlider.hoverBackground': '#FFFFFF2E'
  }
})

monaco.editor.defineTheme('mixdog-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '9B2393' },
    { token: 'string', foreground: 'C41A16' },
    { token: 'number', foreground: '1C00CF' },
    { token: 'comment', foreground: '5D6C79', fontStyle: 'italic' },
    { token: 'type', foreground: '0B4F79' },
    { token: 'annotation', foreground: '643820' }
  ],
  colors: {
    'editor.background': '#FFFFFF',
    'editor.lineHighlightBackground': '#F4F6FA',
    'editorLineNumber.foreground': '#B4B4BA',
    'editorLineNumber.activeForeground': '#3C3C43',
    'editor.selectionBackground': '#B4D8FD'
  }
})

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
export const currentTheme = (): string => (darkQuery.matches ? 'mixdog-dark' : 'mixdog-light')
darkQuery.addEventListener('change', () => monaco.editor.setTheme(currentTheme()))

/** File extension -> Monaco language id. JSP / Vue SFC use HTML highlighting until LSP lands. */
const LANG: Record<string, string> = {
  java: 'java', kt: 'kotlin', jsp: 'html', jspf: 'html', tag: 'html', vue: 'html',
  html: 'html', htm: 'html', xml: 'xml', xsd: 'xml', js: 'javascript', mjs: 'javascript',
  cjs: 'javascript', ts: 'typescript', json: 'json', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', yml: 'yaml', yaml: 'yaml', properties: 'ini', ini: 'ini', md: 'markdown',
  sh: 'shell', bat: 'bat', cmd: 'bat', ps1: 'powershell', py: 'python', txt: 'plaintext'
}

export function languageOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return LANG[ext] ?? 'plaintext'
}

/* ---------- open documents (one Monaco model per file) ---------- */
export interface Doc {
  model: monaco.editor.ITextModel
  savedVersion: number
  viewState: monaco.editor.ICodeEditorViewState | null
}
export const docs = new Map<string, Doc>()

export function createDoc(path: string, content: string): Doc {
  const model = monaco.editor.createModel(content, languageOf(path), monaco.Uri.file(path))
  const doc: Doc = { model, savedVersion: model.getAlternativeVersionId(), viewState: null }
  docs.set(path, doc)
  return doc
}

export function disposeDoc(path: string): void {
  docs.get(path)?.model.dispose()
  docs.delete(path)
}

/** True while the IDE replaces a buffer with the disk version - not a user edit. */
export const externalReload = { active: false }

/** The single code editor instance (set by CodeEditor.vue) - used by IDE commands / AI. */
export const editorRef: { current: monaco.editor.IStandaloneCodeEditor | null } = { current: null }

export { monaco }
