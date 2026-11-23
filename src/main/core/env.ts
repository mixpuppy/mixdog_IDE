/**
 * When the IDE itself is started from inside another Claude Code session
 * (e.g. from a terminal in the Claude app), it inherits that host's private
 * variables: session id, proxy base URL, messaging socket, "child session"
 * flags... A `claude` launched from the IDE would then run as a child of that
 * host instead of as the user's own session. Remove them once at startup so
 * every child process (Claude Code, shells, Maven, Tomcat) starts clean.
 *
 * Only applied when such a host is detected; settings a user put in their own
 * environment (e.g. CLAUDE_CODE_OAUTH_TOKEN, Bedrock/Vertex switches) are kept.
 */
const KEEP = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS'
])

const HOST_ONLY = /^(CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PREVIEW_)|^(CLAUDECODE|CLAUDE_PID|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE)$/

export function sanitizeHostClaudeEnv(): string[] {
  const nested = 'CLAUDECODE' in process.env || 'CLAUDE_CODE_HOST_SESSION_ID' in process.env || 'CLAUDE_CODE_SESSION_ID' in process.env
  if (!nested) return []
  const removed: string[] = []
  for (const key of Object.keys(process.env)) {
    if (HOST_ONLY.test(key) && !KEEP.has(key)) {
      delete process.env[key]
      removed.push(key)
    }
  }
  // the host's local proxy, not something the user configured
  if (process.env['ANTHROPIC_BASE_URL']?.match(/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/)) {
    delete process.env['ANTHROPIC_BASE_URL']
    removed.push('ANTHROPIC_BASE_URL')
  }
  return removed
}
