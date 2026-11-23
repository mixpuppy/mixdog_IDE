/**
 * Compiler problems of the last build shown in the editor as squiggles (Monaco markers).
 * Models opened later get their markers when they are created.
 */
import { monaco } from './monaco'

export interface Problem {
  file: string
  line: number
  col: number
  severity: 'error' | 'warning'
  message: string
}

const OWNER = 'mixdog-build'
let current: Problem[] = []
const norm = (p: string): string => p.replace(/\//g, '\\').toLowerCase()

function markersFor(model: monaco.editor.ITextModel): monaco.editor.IMarkerData[] {
  const path = norm(model.uri.fsPath)
  return current
    .filter((p) => norm(p.file) === path)
    .map((p) => {
      const line = Math.min(Math.max(1, p.line), model.getLineCount())
      const text = model.getLineContent(line)
      // underline the word at the column (javac columns point at the start of the problem)
      const col = Math.min(Math.max(1, p.col), text.length + 1)
      const word = model.getWordAtPosition({ lineNumber: line, column: col })
      const startColumn = word ? word.startColumn : col === text.length + 1 ? Math.max(1, text.search(/\S/) + 1) : col
      const endColumn = word ? word.endColumn : text.length + 1
      return {
        severity: p.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        message: p.message,
        source: '컴파일',
        startLineNumber: line,
        startColumn,
        endLineNumber: line,
        endColumn: Math.max(endColumn, startColumn + 1)
      }
    })
}

export function setProblemMarkers(list: Problem[]): void {
  current = list
  for (const m of monaco.editor.getModels()) monaco.editor.setModelMarkers(m, OWNER, markersFor(m))
}

monaco.editor.onDidCreateModel((m) => {
  if (current.length) monaco.editor.setModelMarkers(m, OWNER, markersFor(m))
})
