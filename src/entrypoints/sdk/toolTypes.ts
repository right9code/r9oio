// Minimal local stand-in for the upstream generated SDK tool types.
// Only names re-exported by agentSdkTypes.ts (`export *`) are declared.

import type { SdkMcpToolDefinition } from './runtimeTypes.js'

export type ToolAnnotations = {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
  [key: string]: unknown
}

export type ToolCallResult = {
  content: unknown
  isError?: boolean
  [key: string]: unknown
}

export type ToolDefinition<Shape extends Record<string, unknown> = Record<string, unknown>> =
  SdkMcpToolDefinition<Shape>
