/** Merge request form (GitLab) opened from the branch popup / Git view. */
import { reactive } from 'vue'

export const mr = reactive({
  /** open form: source branch and optional target */
  req: null as { branch: string; target: string | null } | null,
  /** the MR tool shows this MR's detail (set after creating one, or from the Git view) */
  focus: null as number | null
})

export function openMergeRequestForm(branch: string, target: string | null = null): void {
  mr.req = { branch, target }
}

/** open the MR tool window on an MR (its approval / merge screen) */
export async function showMergeRequest(iid: number | null = null): Promise<void> {
  const { showTool } = await import('./layout')
  mr.focus = iid
  showTool('mr')
}

export function closeMergeRequest(): void {
  mr.req = null
}
