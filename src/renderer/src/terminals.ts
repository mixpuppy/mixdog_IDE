/** Routes pty output from the main process to the xterm instance that owns each id. */
type Handler = { data: (d: string) => void; exit: (code: number) => void }
const handlers = new Map<string, Handler>()

window.api.pty.onData((id, data) => handlers.get(id)?.data(data))
window.api.pty.onExit((id, code) => handlers.get(id)?.exit(code))

export function bindTerminal(id: string, h: Handler): () => void {
  handlers.set(id, h)
  return () => {
    if (handlers.get(id) === h) handlers.delete(id)
  }
}
