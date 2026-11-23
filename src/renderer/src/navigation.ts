/**
 * Ctrl+click / F12 / Ctrl+hover preview in the editor, backed by the main-process text rules
 * (src/main/tools/navigate.ts). Targets in other files open as normal editor tabs.
 */
import type { editor, languages, IRange, IPosition, Uri } from 'monaco-editor'
import { monaco, docs, createDoc } from './monaco'
import { store } from './store'
import { openAt } from './search'

const LANGS = ['java', 'kotlin', 'xml', 'html', 'ini']

/** the open-document path of a Monaco uri (docs keep the original spelling of the path) */
function docPath(uri: Uri): string {
  const fs = uri.fsPath.toLowerCase()
  for (const k of docs.keys()) if (k.toLowerCase() === fs) return k
  return uri.fsPath
}

/** Peek / hover preview need a model for the target file: load it like an opened file would */
async function modelFor(path: string): Promise<editor.ITextModel | null> {
  for (const [k, d] of docs) if (k.toLowerCase() === path.toLowerCase()) return d.model
  try {
    const text = await window.api.fs.readFile(path)
    for (const [k, d] of docs) if (k.toLowerCase() === path.toLowerCase()) return d.model
    return createDoc(path, text).model
  } catch {
    return null
  }
}

let registered = false

export function registerNavigation(): void {
  if (registered) return
  registered = true
  const provider: languages.DefinitionProvider = {
    provideDefinition: async (model, pos) => {
      const project = store.project?.path
      if (!project) return null
      const path = docPath(model.uri)
      const locs = await window.api.nav.definition(project, path, model.getValue(), model.getOffsetAt(pos)).catch(() => [])
      const out: languages.Location[] = []
      for (const l of locs.slice(0, 30)) {
        const m = await modelFor(l.path)
        if (!m) continue
        const line = Math.min(l.line, m.getLineCount())
        const word = m.getWordAtPosition({ lineNumber: line, column: l.col })
        out.push({
          uri: m.uri,
          range: { startLineNumber: line, startColumn: word?.startColumn ?? l.col, endLineNumber: line, endColumn: word?.endColumn ?? l.col + 1 }
        })
      }
      return out
    }
  }
  for (const lang of LANGS) monaco.languages.registerDefinitionProvider(lang, provider)

  // a definition in another file: open it as a tab (Monaco alone can't switch models)
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition?: IRange | IPosition) {
      const s = selectionOrPosition as (IRange & IPosition) | undefined
      const line = s?.startLineNumber ?? s?.lineNumber
      const col = s?.startColumn ?? s?.column
      void openAt(docPath(resource), line, col)
      return true
    }
  })
}
