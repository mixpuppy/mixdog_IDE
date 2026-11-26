/** Conflict resolver window state (opened from the Git view's conflict list or an MR). */
import { reactive } from 'vue'

export const conflictUi = reactive({
  open: false,
  files: [] as string[],
  index: 0,
  done: {} as Record<string, true>,
  /** an MR whose conflicts are being resolved: commit + push at the end */
  mr: null as null | { iid: number; source: string; target: string }
})

export function openResolver(files: string[], start = files[0], mr: typeof conflictUi.mr = null): void {
  conflictUi.files = [...files]
  conflictUi.index = Math.max(0, files.indexOf(start))
  conflictUi.done = {}
  conflictUi.mr = mr
  conflictUi.open = true
}

export function closeResolver(): void {
  conflictUi.open = false
}
