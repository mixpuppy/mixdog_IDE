/** Child-process helpers for Windows (.bat / .cmd need cmd.exe since Node 18.20+). */
import { spawn, execFile, type ChildProcess } from 'child_process'

export interface RunOptions {
  cwd: string
  env?: Record<string, string | undefined>
  onLine: (line: string, stream: 'out' | 'err') => void
  onExit: (code: number | null) => void
}

/**
 * Run a command line through cmd.exe with UTF-8 code page.
 * `exe` is quoted for you; `args` is passed verbatim.
 */
export function runCmd(exe: string, args: string, opts: RunOptions): ChildProcess {
  const line = `chcp 65001 >nul && "${exe}" ${args}`
  // Merge env case-insensitively (Windows has "Path", we set "PATH");
  // an `undefined` value removes the variable (e.g. JRE_HOME).
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === k.toLowerCase()) delete env[key]
    if (v !== undefined) env[k] = v
  }
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    cwd: opts.cwd,
    env,
    windowsVerbatimArguments: true,
    windowsHide: true
  })
  pipeLines(child, opts.onLine)
  child.on('close', (code) => opts.onExit(code))
  child.on('error', (e) => {
    opts.onLine(String(e), 'err')
    opts.onExit(-1)
  })
  return child
}

function pipeLines(child: ChildProcess, onLine: RunOptions['onLine']): void {
  for (const [stream, name] of [
    [child.stdout, 'out'],
    [child.stderr, 'err']
  ] as const) {
    let buf = ''
    stream?.setEncoding('utf-8')
    stream?.on('data', (chunk: string) => {
      buf += chunk
      const parts = buf.split(/\r?\n/)
      buf = parts.pop() ?? ''
      for (const p of parts) onLine(p, name)
    })
    stream?.on('end', () => buf && onLine(buf, name))
  }
}

/** Kill a process and all of its children (cmd -> java). */
export function killTree(pid: number | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!pid) return resolve()
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}
