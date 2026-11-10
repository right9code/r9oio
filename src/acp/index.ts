import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { type TauAcpBackend, EchoBackend } from './backend.js'
import { TauEngineBackend } from './tauBackend.js'
import { TauAcpAgent } from './agent.js'

/**
 * Start the Tau ACP agent server over stdio (the `tau acp` subcommand).
 *
 * The editor (Zed, JetBrains 2026.1+, the VS Code ACP Client extension, …)
 * spawns this process and speaks JSON-RPC over stdin/stdout. Resolves when the
 * connection closes.
 *
 * IMPORTANT: stdout is the protocol channel — nothing else may write to it.
 * All diagnostics must go to stderr (or a log file). Callers must ensure Tau's
 * loggers are not pointed at stdout before invoking this.
 *
 * @param backend  The agent engine. Defaults to {@link TauEngineBackend},
 *                 which runs the real Tau agent (via a headless subprocess).
 *                 Pass {@link EchoBackend} to exercise the protocol without
 *                 invoking the model.
 */
export function runAcpServer(
  backend: TauAcpBackend = new TauEngineBackend(),
): Promise<void> {
  // ndJsonStream(outgoing, incoming): first arg is what the agent writes to the
  // client (stdout), second is what it reads from the client (stdin).
  //
  // We wire WHATWG streams manually rather than via Node's Readable/Writable
  // toWeb(): toWeb() on process.stdin is unreliable here (it may not resume the
  // stream, dropping buffered input), whereas attaching a 'data' listener and
  // calling resume() deterministically delivers both buffered and future bytes.
  const toClient = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, err => (err ? reject(err) : resolve()))
      })
    },
  })
  const fromClient = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on('data', (chunk: Buffer | string) => {
        // Tau's startup may have put stdin in string mode (setEncoding('utf8')),
        // in which case 'data' yields strings, not Buffers. new Uint8Array(str)
        // would silently produce a zero-filled array, so encode strings to
        // bytes explicitly. Buffers are copied into a plain Uint8Array.
        const bytes =
          typeof chunk === 'string'
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk)
        controller.enqueue(bytes)
      })
      process.stdin.once('end', () => {
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
      process.stdin.once('error', err => controller.error(err))
      process.stdin.resume()
    },
  })
  const stream = ndJsonStream(toClient, fromClient)
  const connection = new AgentSideConnection(
    conn => new TauAcpAgent(conn, backend),
    stream,
  )

  return connection.closed
}

export { EchoBackend } from './backend.js'
export type {
  TauAcpBackend,
  TurnContext,
  BackendToolCall,
  PermissionOutcome,
} from './backend.js'
