import type { ModelOption } from './modelHealth.js';

export interface QuotaFailureContext {
  taskSubject: string;
  failedModel: ModelOption;
  error: string;
  suggestedAlternatives: ModelOption[];
}

export type QuotaResolution =
  | { action: 'retry_with_new_model'; newModel: ModelOption }
  | { action: 'pause_and_wait_user' }
  | { action: 'abort_task' };

/**
 * Checks if an error corresponds to rate limits, quota exhaustion, or 429 status.
 */
export function isQuotaOrRateLimitError(error: any): boolean {
  if (!error) return false;
  const str = String(error.message || error).toLowerCase();
  return (
    str.includes('429') ||
    str.includes('quota') ||
    str.includes('rate limit') ||
    str.includes('resource_exhausted') ||
    str.includes('insufficient_quota') ||
    str.includes('overloaded') ||
    str.includes('empty response') ||
    str.includes('prompt is too long') ||
    str.includes('context_length_exceeded')
  );
}

/**
 * Creates recovery prompt options when an agent runs into quota limits.
 */
export function buildQuotaRecoveryOptions(context: QuotaFailureContext): {
  message: string;
  choices: Array<{ label: string; model?: ModelOption }>;
} {
  const message = `⚠️ Model '${context.failedModel.label}' exhausted its quota/rate-limit while executing task: "${context.taskSubject}".\nError: ${context.error}\n\nSelect a replacement model to resume work:`;

  const choices = context.suggestedAlternatives.map(alt => ({
    label: `Switch to ${alt.label}`,
    model: alt,
  }));

  return { message, choices };
}
