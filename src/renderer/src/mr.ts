/** Merge request form (GitLab) opened from the branch popup / Git view. */
import { reactive } from 'vue'

export const mr = reactive({
  /** open form: source branch and optional target */
  req: null as { branch: string; target: string | null } | null
})

export function openMergeRequestForm(branch: string, target: string | null = null): void {
  mr.req = { branch, target }
}

export function closeMergeRequest(): void {
  mr.req = null
}
