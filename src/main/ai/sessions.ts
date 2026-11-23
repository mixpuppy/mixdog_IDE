/**
 * Lists Claude Code conversations for a project folder.
 *
 * Claude Code keeps one JSONL transcript per session in
 * ~/.claude/projects/<folder path with every non-alphanumeric char as "-">/<session-id>.jsonl.
 * The file format is internal to Claude Code, so this only reads a few
 * well-known record shapes (titles, user prompts) and degrades gracefully.
 * Resuming itself goes through the official `claude --resume <id>`.
 */
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

export interface SessionInfo {
  id: string
  title: string
  /** where the title came from: name you gave it / Claude's auto title / first prompt */
  titleSource: 'custom' | 'ai' | 'prompt' | 'none'
  updated: number
  created: number | null
  /** number of prompts the user typed */
  prompts: number
  /** cli (terminal / this IDE), claude-desktop (Claude app), sdk-cli (scripts) */
  entrypoint: string
  lastPrompt: string
}

const ROOT = join(homedir(), '.claude', 'projects')
const MAX_SESSIONS = 60
const MAX_READ = 8 * 1024 * 1024 // don't parse giant transcripts entirely

export function projectSessionDir(projectPath: string): string {
  return join(ROOT, projectPath.replace(/[^a-zA-Z0-9]/g, '-'))
}

/** Last JSON string value of `"key":"..."` in text (handles escapes). */
function lastString(text: string, key: string): string | null {
  const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g')
  let m: RegExpExecArray | null
  let last: string | null = null
  while ((m = re.exec(text))) last = m[1]
  if (last === null) return null
  try {
    return JSON.parse(`"${last}"`)
  } catch {
    return last
  }
}

/** Text a user actually typed (not tool results, slash-command wrappers or IDE context). */
function promptText(content: unknown): string | null {
  let t: string | null = null
  if (typeof content === 'string') t = content
  else if (Array.isArray(content)) {
    const block = content.find((b) => b && b.type === 'text' && typeof b.text === 'string')
    if (content.some((b) => b && b.type === 'tool_result')) return null
    t = block?.text ?? null
  }
  if (!t) return null
  t = t.trim()
  if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return null
  return t
}

async function readSession(file: string): Promise<SessionInfo | null> {
  const st = await fs.stat(file)
  const fh = await fs.open(file, 'r')
  let text: string
  try {
    const len = Math.min(st.size, MAX_READ)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)
    text = buf.toString('utf-8')
  } finally {
    await fh.close()
  }

  let firstPrompt: string | null = null
  let lastPrompt = ''
  let prompts = 0
  let created: number | null = null
  let entrypoint = ''
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"')) continue
    try {
      const j = JSON.parse(line)
      if (j.type !== 'user' || j.isMeta || j.isSidechain) continue
      entrypoint ||= j.entrypoint ?? ''
      if (created === null && j.timestamp) created = Date.parse(j.timestamp)
      const p = promptText(j.message?.content)
      if (!p) continue
      prompts++
      firstPrompt ??= p
      lastPrompt = p
    } catch {
      /* partial last line */
    }
  }

  const custom = lastString(text, 'customTitle')
  const aiTitle = lastString(text, 'aiTitle')
  const title = custom ?? aiTitle ?? firstPrompt
  if (!title && prompts === 0) return null // never used (e.g. closed at the trust prompt)
  return {
    id: basename(file, '.jsonl'),
    title: (title ?? '(제목 없음)').replace(/\s+/g, ' ').slice(0, 120),
    titleSource: custom ? 'custom' : aiTitle ? 'ai' : firstPrompt ? 'prompt' : 'none',
    updated: st.mtimeMs,
    created,
    prompts,
    entrypoint: entrypoint || 'cli',
    lastPrompt: lastPrompt.replace(/\s+/g, ' ').slice(0, 160)
  }
}

export async function listSessions(projectPath: string): Promise<SessionInfo[]> {
  const dir = projectSessionDir(projectPath)
  let files: { path: string; mtime: number }[]
  try {
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl'))
    files = await Promise.all(names.map(async (n) => ({ path: join(dir, n), mtime: (await fs.stat(join(dir, n))).mtimeMs })))
  } catch {
    return []
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const out: SessionInfo[] = []
  for (const f of files.slice(0, MAX_SESSIONS)) {
    try {
      const s = await readSession(f.path)
      if (s) out.push(s)
    } catch {
      /* unreadable - skip */
    }
  }
  return out
}
