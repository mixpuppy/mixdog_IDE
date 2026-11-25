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

export interface ErrorAction {
  label: string
  primary?: boolean
  danger?: boolean
  run: () => unknown
}

export interface ErrorInfo {
  title: string
  /** what happened, in plain words */
  summary: string
  /** files / items the error is about */
  items?: string[]
  /** what to do about it */
  hint?: string
  /** side note (e.g. a harmless warning that was also printed) */
  note?: string
  /** the full original output */
  raw: string
  actions?: ErrorAction[]
}

export const ui = reactive({
  /** error window (full text, explanation, fix buttons) */
  error: null as ErrorInfo | null,
  /** sheet with several answers, e.g. "이 창 / 새 창 / 취소" */
  choice: null as null | { title: string; message?: string; options: string[]; resolve: (i: number | null) => void },
  menu: null as { x: number; y: number; items: MenuItem[] } | null,
  ask: null as null | {
    title: string
    message?: string
    /** undefined = confirm only (no text field) */
    value?: string
    placeholder?: string
    /** mask the text field (passwords) */
    password?: boolean
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

/** Open the error window (stays until closed, text can be selected and copied). */
export function showError(info: ErrorInfo): void {
  ui.error = info
}

export function closeMenu(): void {
  ui.menu = null
}

/** Ask for a line of text. Resolves null on cancel. */
export function promptText(
  title: string,
  opts: { message?: string; value?: string; placeholder?: string; ok?: string; password?: boolean; check?: { label: string; value: boolean } } = {}
): Promise<{ value: string; checked: boolean } | null> {
  return new Promise((resolve) => {
    ui.ask = { title, message: opts.message, value: opts.value ?? '', placeholder: opts.placeholder, password: opts.password, ok: opts.ok ?? '확인', check: opts.check, resolve }
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
