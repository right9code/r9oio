// Minimal local stand-in for the upstream SDK runtime types (non-serializable
// callbacks, interfaces, and session handles). Only names imported across the
// repo or re-exported by agentSdkTypes.ts are declared.

import type { SDKMessage, SDKResultMessage, SDKSessionInfo, SDKUserMessage } from './coreTypes.js'

/** Match zod's raw-shape object type without importing zod at runtime. */
export type AnyZodRawShape = {
  [key: string]: { _output: unknown } | { _zod: { output: unknown } } | unknown
}

/** Extract the parsed output type from a zod raw shape (loose local version). */
export type InferShape<T> = T extends AnyZodRawShape
  ? { [K in keyof T]?: unknown }
  : unknown

export type SdkMcpToolDefinition<Shape extends AnyZodRawShape = AnyZodRawShape> = {
  type: 'sdk-mcp-tool'
  name: string
  description: string
  inputSchema: Shape
  handler?: (args: InferShape<Shape>, extra: unknown) => Promise<unknown>
}

export type McpSdkServerConfigWithInstance = {
  type: 'sdk'
  name: string
  instance?: unknown
}

export type EffortLevel =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultracode'

export type SDKUserMessageType = SDKUserMessage

/** Streaming query handle yielded while a query runs. */
export type Query = AsyncGenerator<
  SDKMessage,
  void,
  unknown
> & {
  /** Abort the underlying query. */
  interrupt: () => Promise<void>
  /** Update the set of allowed tools mid-run. */
  setPermissionMode: (mode: string) => Promise<void>
  /** Update the model mid-run. */
  setModel: (model: string | null) => Promise<void>
  /** Supported slash commands exposed by the session. */
  supportedCommands?: Array<{ name: string; description: string; argumentHint?: string }>
  /** Stream user input into the running query. */
  getInput(): AsyncIterable<SDKUserMessage>
}

/** Internal query handle (control-protocol consumers). */
export type InternalQuery = Query

export type McpServerConfig = unknown

export type OptionValue = string | number | boolean | string[] | undefined

export type HooksConfig = unknown

export type SettingsSource = string

export type Options = {
  cwd?: string
  model?: string
  permissionMode?: string
  permissionPromptToolName?: string
  maxTurns?: number
  maxThinkingTokens?: number
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string } | null
  appendSystemPrompt?: string
  includePartialMessages?: boolean
  includeHookEvents?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServers?: Record<string, unknown>
  hooks?: Record<string, unknown>
  abortController?: AbortController
  additionalDirectories?: string[]
  settings?: string | string[]
  pathToClaudeCodeExecutable?: string
  executable?: string
  env?: Record<string, string | undefined>
  stderr?: (data: string) => void
  resume?: string
  forkSession?: boolean
  continueSession?: boolean
  sessionId?: string
  agents?: Record<string, unknown>
  plugins?: unknown
  pathToUsableExecutable?: string
  resetSDKStateOnStart?: boolean
  extraArgs?: Record<string, string | null>
  [key: string]: unknown
}

/** Internal options carry debug/telemetry knobs beyond the public Options. */
export type InternalOptions = Options & {
  isNonInteractiveSession?: boolean
  [key: string]: unknown
}

export type SDKSessionOptions = Options

export type SDKMessageForSession = SDKMessage

export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}

export type SessionMessage = SDKMessage | SDKUserMessage

export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
}

export type GetSessionInfoOptions = {
  dir?: string
}

export type SessionMutationOptions = {
  dir?: string
}

export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}

export type ForkSessionResult = {
  sessionId: string
}

export type SDKSession = {
  sessionId: string
  query: Query
  messages: () => Promise<SessionMessage[]>
  info: () => Promise<SDKSessionInfo>
  interrupt: () => Promise<void>
}

export type ListSessionsResult = SDKSessionInfo
