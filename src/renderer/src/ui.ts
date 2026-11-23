/** Small shared UI services: context menu and input / confirm sheets (Electron has no window.prompt). */
import { reactive } from 'vue'

export interface MenuItem {
  label: string
  action?: () => unknown
  danger?: boolean
  disabled?: boolean
  /** dim secondary text after the label (e.g. a path), cut off when long */
  hint?: string
  /** shows a check column (true = ✓) */
  checked?: boolean
  /** section title (not clickable) */
  header?: boolean
  /** separator line above this item */
  sep?: boolean
}

export const ui = reactive({
  /** sheet with several answers, e.g. "이 창 / 새 창 / 취소" */
  choice: null as null | { title: string; message?: string; options: string[]; resolve: (i: number | null) => void },
  menu: null as { x: number; y: number; items: MenuItem[] } | null,
  ask: null as null | {
    title: string
    message?: string
    /** undefined = confirm only (no text field) */
    value?: string
    placeholder?: string
    ok: string
    danger?: boolean
    check?: { label: string; value: boolean }
    resolve: (r: { value: string; checked: boolean } | null) => void
  }
})

export function openMenu(e: MouseEvent, items: MenuItem[]): void {
  e.preventDefault()
  e.stopPropagation()
  ui.menu = { x: e.clientX, y: e.clientY, items }
}

export function closeMenu(): void {
  ui.menu = null
}

/** Ask for a line of text. Resolves null on cancel. */
export function promptText(
  title: string,
  opts: { message?: string; value?: string; placeholder?: string; ok?: string; check?: { label: string; value: boolean } } = {}
): Promise<{ value: string; checked: boolean } | null> {
  return new Promise((resolve) => {
    ui.ask = { title, message: opts.message, value: opts.value ?? '', placeholder: opts.placeholder, ok: opts.ok ?? '확인', check: opts.check, resolve }
  })
}

export function confirmSheet(title: string, message: string, ok = '확인', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    ui.ask = { title, message, ok, danger, resolve: (r) => resolve(!!r) }
  })
}

/** Ask with several buttons; resolves the chosen index (first = default), or null on cancel / Esc. */
export function chooseSheet(title: string, message: string, options: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    ui.choice = { title, message, options, resolve }
  })
}
