// Minimal local stand-in for the upstream generated SDK core types.
// The real file is generated from coreSchemas.ts via `bun scripts/generate-sdk-types.ts`,
// which is not part of this source checkout. Every generated type re-exported
// by coreTypes.ts / agentSdkTypes.ts is declared here, derived from the Zod
// schemas in coreSchemas.ts where a schema exists so shapes stay in sync.

import type { z } from 'zod/v4'
import {
  ApiKeySourceSchema,
  AsyncHookJSONOutputSchema,
  ConfigChangeHookInputSchema,
  CwdChangedHookInputSchema,
  DirectoryAddedHookInputSchema,
  ElicitationHookInputSchema,
  ElicitationResultHookInputSchema,
  ExitReasonSchema,
  FastModeStateSchema,
  FileChangedHookInputSchema,
  HookEventSchema,
  HookInputSchema,
  HookJSONOutputSchema,
  InstructionsLoadedHookInputSchema,
  McpServerConfigForProcessTransportSchema,
  McpServerStatusSchema,
  MessageDisplayHookInputSchema,
  ModelInfoSchema,
  ModelUsageSchema,
  NotificationHookInputSchema,
  PermissionDeniedHookInputSchema,
  PermissionModeSchema,
  PermissionRequestHookInputSchema,
  PermissionResultSchema,
  PermissionUpdateSchema,
  PostCompactHookInputSchema,
  PostModelSwitchHookInputSchema,
  PostToolBatchHookInputSchema,
  PostToolUseFailureHookInputSchema,
  PostToolUseHookInputSchema,
  PreCompactHookInputSchema,
  PreModelSwitchHookInputSchema,
  PreToolUseHookInputSchema,
  RewindFilesResultSchema,
  SDKAPIRetryMessageSchema,
  SDKAssistantMessageErrorSchema,
  SDKAssistantMessageSchema,
  SDKCompactBoundaryMessageSchema,
  SDKFilesPersistedEventSchema,
  SDKHookProgressMessageSchema,
  SDKHookResponseMessageSchema,
  SDKHookStartedMessageSchema,
  SDKLocalCommandOutputMessageSchema,
  SDKMessageSchema,
  SDKPartialAssistantMessageSchema,
  SDKPermissionDenialSchema,
  SDKPostTurnSummaryMessageSchema,
  SDKPromptSuggestionMessageSchema,
  SDKRateLimitEventSchema,
  SDKRateLimitInfoSchema,
  SDKResultErrorSchema,
  SDKResultMessageSchema,
  SDKResultSuccessSchema,
  SDKSessionInfoSchema,
  SDKStatusMessageSchema,
  SDKStatusSchema,
  SDKStreamlinedTextMessageSchema,
  SDKStreamlinedToolUseSummaryMessageSchema,
  SDKSystemMessageSchema,
  SDKTaskNotificationMessageSchema,
  SDKTaskProgressMessageSchema,
  SDKTaskStartedMessageSchema,
  SDKToolProgressMessageSchema,
  SDKUserMessageReplaySchema,
  SDKUserMessageSchema,
  SessionEndHookInputSchema,
  SessionStartHookInputSchema,
  SetupHookInputSchema,
  StopFailureHookInputSchema,
  StopHookInputSchema,
  SubagentStartHookInputSchema,
  SubagentStopHookInputSchema,
  SyncHookJSONOutputSchema,
  TaskCompletedHookInputSchema,
  TaskCreatedHookInputSchema,
  TeammateIdleHookInputSchema,
  UserPromptExpansionHookInputSchema,
  UserPromptSubmitHookInputSchema,
} from './coreSchemas.js'

type Infer<S extends (...args: any) => any> = S extends { _output: infer O } ? O : z.infer<ReturnType<S>>

export type ApiKeySource = Infer<typeof ApiKeySourceSchema>
export type AsyncHookJSONOutput = Infer<typeof AsyncHookJSONOutputSchema>
export type ConfigChangeHookInput = Infer<typeof ConfigChangeHookInputSchema>
export type CwdChangedHookInput = Infer<typeof CwdChangedHookInputSchema>
export type DirectoryAddedHookInput = Infer<typeof DirectoryAddedHookInputSchema>
export type ElicitationHookInput = Infer<typeof ElicitationHookInputSchema>
export type ElicitationResultHookInput = Infer<typeof ElicitationResultHookInputSchema>
export type ExitReason = Infer<typeof ExitReasonSchema>
export type FastModeState = Infer<typeof FastModeStateSchema>
export type FileChangedHookInput = Infer<typeof FileChangedHookInputSchema>
export type HookEvent = Infer<typeof HookEventSchema>
export type HookInput = Infer<typeof HookInputSchema>
export type HookJSONOutput = Infer<typeof HookJSONOutputSchema>
export type InstructionsLoadedHookInput = Infer<typeof InstructionsLoadedHookInputSchema>
export type McpServerConfigForProcessTransport = Infer<typeof McpServerConfigForProcessTransportSchema>
export type McpServerStatus = Infer<typeof McpServerStatusSchema>
export type MessageDisplayHookInput = Infer<typeof MessageDisplayHookInputSchema>
export type ModelInfo = Infer<typeof ModelInfoSchema>
export type ModelUsage = Infer<typeof ModelUsageSchema>
export type NotificationHookInput = Infer<typeof NotificationHookInputSchema>
export type PermissionDeniedHookInput = Infer<typeof PermissionDeniedHookInputSchema>
export type PermissionMode = Infer<typeof PermissionModeSchema>
export type PermissionRequestHookInput = Infer<typeof PermissionRequestHookInputSchema>
export type PermissionResult = Infer<typeof PermissionResultSchema>
export type PermissionUpdate = Infer<typeof PermissionUpdateSchema>
export type PostCompactHookInput = Infer<typeof PostCompactHookInputSchema>
export type PostModelSwitchHookInput = Infer<typeof PostModelSwitchHookInputSchema>
export type PostToolBatchHookInput = Infer<typeof PostToolBatchHookInputSchema>
export type PostToolUseFailureHookInput = Infer<typeof PostToolUseFailureHookInputSchema>
export type PostToolUseHookInput = Infer<typeof PostToolUseHookInputSchema>
export type PreCompactHookInput = Infer<typeof PreCompactHookInputSchema>
export type PreModelSwitchHookInput = Infer<typeof PreModelSwitchHookInputSchema>
export type PreToolUseHookInput = Infer<typeof PreToolUseHookInputSchema>
export type RewindFilesResult = Infer<typeof RewindFilesResultSchema>
export type SDKAPIRetryMessage = Infer<typeof SDKAPIRetryMessageSchema>
export type SDKAssistantMessage = Infer<typeof SDKAssistantMessageSchema>
export type SDKAssistantMessageError = Infer<typeof SDKAssistantMessageErrorSchema>
export type SDKCompactBoundaryMessage = Infer<typeof SDKCompactBoundaryMessageSchema>
export type SDKFilesPersistedEvent = Infer<typeof SDKFilesPersistedEventSchema>
export type SDKHookProgressMessage = Infer<typeof SDKHookProgressMessageSchema>
export type SDKHookResponseMessage = Infer<typeof SDKHookResponseMessageSchema>
export type SDKHookStartedMessage = Infer<typeof SDKHookStartedMessageSchema>
export type SDKLocalCommandOutputMessage = Infer<typeof SDKLocalCommandOutputMessageSchema>
export type SDKMessage = Infer<typeof SDKMessageSchema>
export type SDKPartialAssistantMessage = Infer<typeof SDKPartialAssistantMessageSchema>
export type SDKPermissionDenial = Infer<typeof SDKPermissionDenialSchema>
export type SDKPostTurnSummaryMessage = Infer<typeof SDKPostTurnSummaryMessageSchema>
export type SDKPromptSuggestionMessage = Infer<typeof SDKPromptSuggestionMessageSchema>
export type SDKRateLimitEvent = Infer<typeof SDKRateLimitEventSchema>
export type SDKRateLimitInfo = Infer<typeof SDKRateLimitInfoSchema>
export type SDKResultError = Infer<typeof SDKResultErrorSchema>
export type SDKResultMessage = Infer<typeof SDKResultMessageSchema>
export type SDKResultSuccess = Infer<typeof SDKResultSuccessSchema>
export type SDKSessionInfo = Infer<typeof SDKSessionInfoSchema>
export type SDKStatus = Infer<typeof SDKStatusSchema>
export type SDKStatusMessage = Infer<typeof SDKStatusMessageSchema>
export type SDKStreamlinedTextMessage = Infer<typeof SDKStreamlinedTextMessageSchema>
export type SDKStreamlinedToolUseSummaryMessage = Infer<typeof SDKStreamlinedToolUseSummaryMessageSchema>
export type SDKSystemMessage = Infer<typeof SDKSystemMessageSchema>
export type SDKTaskNotificationMessage = Infer<typeof SDKTaskNotificationMessageSchema>
export type SDKTaskProgressMessage = Infer<typeof SDKTaskProgressMessageSchema>
export type SDKTaskStartedMessage = Infer<typeof SDKTaskStartedMessageSchema>
export type SDKToolProgressMessage = Infer<typeof SDKToolProgressMessageSchema>
export type SDKUserMessage = Infer<typeof SDKUserMessageSchema>
export type SDKUserMessageReplay = Infer<typeof SDKUserMessageReplaySchema>
export type SessionEndHookInput = Infer<typeof SessionEndHookInputSchema>
export type SessionStartHookInput = Infer<typeof SessionStartHookInputSchema>
export type SetupHookInput = Infer<typeof SetupHookInputSchema>
export type StopFailureHookInput = Infer<typeof StopFailureHookInputSchema>
export type StopHookInput = Infer<typeof StopHookInputSchema>
export type SubagentStartHookInput = Infer<typeof SubagentStartHookInputSchema>
export type SubagentStopHookInput = Infer<typeof SubagentStopHookInputSchema>
export type SyncHookJSONOutput = Infer<typeof SyncHookJSONOutputSchema>
export type TaskCompletedHookInput = Infer<typeof TaskCompletedHookInputSchema>
export type TaskCreatedHookInput = Infer<typeof TaskCreatedHookInputSchema>
export type TeammateIdleHookInput = Infer<typeof TeammateIdleHookInputSchema>
export type UserPromptExpansionHookInput = Infer<typeof UserPromptExpansionHookInputSchema>
export type UserPromptSubmitHookInput = Infer<typeof UserPromptSubmitHookInputSchema>
