/**
 * "IDE tools" MCP server (Streamable HTTP on 127.0.0.1).
 *
 * Claude Code (and later Codex / Gemini CLI, which also speak MCP) connects
 * here to see what is happening in the IDE and to act on it: IDE state, the
 * event log, unsaved editor buffers, build / Tomcat output, build, run, open
 * file. Every call is published to the event bus with source "ai:<client>".
 */
import http from 'http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { history, publish } from '../core/events'
import { invokeCommand } from '../core/commands'
import { ctxByToken, runInScope, scopeOf, type WinCtx } from '../core/windows'
import { buildProject, startRun, stopAll } from '../actions'
import { tomcatState } from '../tools/tomcat'

const SOURCE = 'ai:claude'
/** Load IDE tools upfront instead of behind Claude Code's tool search - Claude needs them on most turns. */
const ALWAYS = { 'anthropic/alwaysLoad': true }
let port = 0

const text = (value: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
})

const fail = (message: string): { content: { type: 'text'; text: string }[]; isError: true } => ({
  content: [{ type: 'text', text: message }],
  isError: true
})

async function project(ctx: WinCtx): Promise<{ path: string; name: string }> {
  const state = (await invokeCommand('ide.state', {}, SOURCE, ctx)) as { project: { path: string; name: string } | null }
  if (!state.project) throw new Error('IDE 에 열린 프로젝트가 없습니다')
  return state.project
}

/** Wrap a tool handler: log it as an AI action and turn exceptions into tool errors. */
function act<A>(ctx: WinCtx, name: string, fn: (args: A) => Promise<ReturnType<typeof text>>) {
  return async (args: A) => {
    publish('ai.tool', { tool: name, args }, SOURCE, scopeOf(ctx))
    try {
      // events published by the tool (build, Tomcat...) belong to this window's project
      return await runInScope(scopeOf(ctx), () => fn(args))
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }
}

/** One server per request, bound to the IDE window the calling Claude session belongs to. */
function buildServer(ctx: WinCtx): McpServer {
  const server = new McpServer(
    { name: 'mixdog-ide', version: '0.1.0' },
    {
      instructions:
        'Tools of the mixdog IDE the user is working in. Call get_ide_state first to see the open project, active file, ' +
        'cursor/selection and server status, and get_recent_events to see what the user just did (files opened/saved/edited, ' +
        'builds, Tomcat logs). Prefer build_project / run_tomcat over running mvn or catalina yourself: they use the ' +
        "project's configured JDK and Tomcat and show output in the IDE."
    }
  )

  server.registerTool(
    'get_ide_state',
    {
      _meta: ALWAYS,
      title: 'IDE 상태',
      description:
        'Open project, active file, cursor and selected text, open tabs (with unsaved flags), JDK, build tool, Tomcat state/URL, last build result.',
      annotations: { readOnlyHint: true }
    },
    act(ctx, 'get_ide_state', async () => text(await invokeCommand('ide.state', {}, SOURCE, ctx)))
  )

  server.registerTool(
    'get_recent_events',
    {
      _meta: ALWAYS,
      title: '최근 IDE 이벤트',
      description:
        'Recent IDE activity log (newest last): file.open/save/close/changed, editor.edit, command, build.*, tomcat.*, ai.tool ... ' +
        'Use type_prefix to filter, e.g. "build." or "file.".',
      inputSchema: { limit: z.number().int().min(1).max(500).optional(), type_prefix: z.string().optional() },
      annotations: { readOnlyHint: true }
    },
    act(ctx, 'get_recent_events', async ({ limit, type_prefix }: { limit?: number; type_prefix?: string }) => {
      const evs = history(limit ?? 60, type_prefix, ctx.project).filter((e) => e.type !== 'build.output' && e.type !== 'tomcat.output')
      return text(evs.map((e) => ({ t: new Date(e.time).toTimeString().slice(0, 8), src: e.source, type: e.type, ...e.data })))
    })
  )

  server.registerTool(
    'get_editor_text',
    {
      _meta: ALWAYS,
      title: '에디터 내용',
      description: 'Current text of a file open in the IDE editor, INCLUDING unsaved changes. Defaults to the active file.',
      inputSchema: { path: z.string().optional() },
      annotations: { readOnlyHint: true }
    },
    act(ctx, 'get_editor_text', async ({ path }: { path?: string }) => {
      const t = await invokeCommand('editor.getText', path ? { path } : {}, SOURCE, ctx)
      return t === null ? fail('그 파일은 에디터에 열려 있지 않습니다. Read 도구로 디스크에서 읽으세요.') : text(t)
    })
  )

  server.registerTool(
    'open_file',
    {
      _meta: ALWAYS,
      title: '파일 열기',
      description: 'Open a file in the IDE editor for the user and move the cursor to a line (to show them something).',
      inputSchema: { path: z.string(), line: z.number().int().min(1).optional() }
    },
    act(ctx, 'open_file', async ({ path, line }: { path: string; line?: number }) => {
      await invokeCommand('editor.goto', { path, line: line ?? 1 }, SOURCE, ctx)
      return text(`열었습니다: ${path}${line ? `:${line}` : ''}`)
    })
  )

  server.registerTool(
    'get_console',
    {
      _meta: ALWAYS,
      title: '콘솔 출력',
      description: 'Last lines of the IDE build console (Maven/Gradle) or Tomcat log.',
      inputSchema: { which: z.enum(['build', 'tomcat']), lines: z.number().int().min(1).max(2000).optional() },
      annotations: { readOnlyHint: true }
    },
    act(ctx, 'get_console', async ({ which, lines }: { which: 'build' | 'tomcat'; lines?: number }) =>
      text(await invokeCommand('console.tail', { which, lines: lines ?? 200 }, SOURCE, ctx))
    )
  )

  server.registerTool(
    'build_project',
    {
      _meta: ALWAYS,
      title: '빌드',
      description: "Build the project with Maven/Gradle using the project's JDK. Waits for the result and returns the tail of the output.",
      annotations: { readOnlyHint: false }
    },
    act(ctx, 'build_project', async () => {
      const p = await project(ctx)
      const ok = await buildProject(p.path, p.name)
      const out = await invokeCommand('console.tail', { which: 'build', lines: ok ? 25 : 120 }, SOURCE, ctx)
      return { ...text(`${ok ? 'BUILD SUCCESS' : 'BUILD FAILED'}\n\n${out}`), ...(ok ? {} : { isError: true as const }) }
    })
  )

  server.registerTool(
    'run_tomcat',
    {
      _meta: ALWAYS,
      title: 'Tomcat 실행',
      description:
        'Build (if the run config says so) and start Tomcat with the project run configuration. Waits until the server is up (max 3 min) and returns the URL and log tail.',
      inputSchema: { debug: z.boolean().optional() }
    },
    act(ctx, 'run_tomcat', async ({ debug }: { debug?: boolean }) => {
      const p = await project(ctx)
      await startRun(p.path, p.name, !!debug)
      for (let i = 0; i < 180 && tomcatState(p.path) === 'starting'; i++) await new Promise((r) => setTimeout(r, 1000))
      const st = (await invokeCommand('ide.state', {}, SOURCE, ctx)) as { tomcat: { state: string; url: string } }
      const log = await invokeCommand('console.tail', { which: 'tomcat', lines: 40 }, SOURCE, ctx)
      return { ...text(`Tomcat: ${st.tomcat.state} ${st.tomcat.url ?? ''}\n\n${log}`), ...(st.tomcat.state === 'running' ? {} : { isError: true as const }) }
    })
  )

  server.registerTool(
    'stop_tomcat',
    { _meta: ALWAYS, title: '중지', description: 'Stop the running build and Tomcat.' },
    act(ctx, 'stop_tomcat', async () => {
      const p = await project(ctx)
      await stopAll(p.path)
      return text('중지했습니다')
    })
  )

  server.registerTool(
    'list_ide_commands',
    { _meta: ALWAYS, title: 'IDE 명령 목록', description: 'All registered IDE commands (id, title, description) usable with run_ide_command.', annotations: { readOnlyHint: true } },
    act(ctx, 'list_ide_commands', async () => text(await invokeCommand('commands.list', {}, SOURCE, ctx)))
  )

  server.registerTool(
    'run_ide_command',
    {
      _meta: ALWAYS,
      title: 'IDE 명령 실행',
      description: 'Run any registered IDE command by id (see list_ide_commands), same as the user clicking it.',
      inputSchema: { id: z.string(), args: z.record(z.string(), z.unknown()).optional() }
    },
    act(ctx, 'run_ide_command', async ({ id, args }: { id: string; args?: Record<string, unknown> }) =>
      text((await invokeCommand(id, args ?? {}, SOURCE, ctx)) ?? '완료')
    )
  )

  return server
}

let starting: Promise<number> | null = null

/**
 * Start the server once, on first use (the first Claude session), not at IDE start:
 * the MCP SDK + zod cost ~40MB of main-process memory that idle windows don't need.
 */
export function ensureMcpServer(): Promise<number> {
  starting ??= startMcpServer().catch((e) => {
    starting = null
    throw e
  })
  return starting
}

/** Start the server on a free loopback port. Requests must carry the bearer token. */
function startMcpServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer(async (req, res) => {
      const ctx = ctxByToken(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))
      if (!ctx || !req.url?.startsWith('/mcp')) {
        res.writeHead(401).end()
        return
      }
      if (req.method !== 'POST') {
        // stateless server: no SSE stream / session deletion
        res.writeHead(405, { Allow: 'POST' }).end()
        return
      }
      let body = ''
      req.setEncoding('utf-8')
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        const server = buildServer(ctx)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        res.on('close', () => {
          transport.close()
          server.close()
        })
        try {
          await server.connect(transport)
          await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
        } catch (e) {
          if (!res.headersSent) res.writeHead(500).end(String(e))
        }
      })
    })
    httpServer.on('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
      publish('ai.mcp.ready', { port })
      resolve(port)
    })
  })
}

/** Claude Code MCP config for one IDE window (its token routes the tools to that window). */
export function mcpConfig(token: string): { mcpServers: Record<string, unknown> } {
  return {
    mcpServers: {
      // not "ide": Claude Code reserves that name for its own JetBrains/VS Code integration and hides its tools
      mixdog: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true }
    }
  }
}
