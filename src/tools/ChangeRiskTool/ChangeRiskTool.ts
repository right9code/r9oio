import { createElement } from 'react'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import {
  assessChangeRisk,
  collectGitChangeSummary,
} from '../../utils/changeRisk.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { CHANGE_RISK_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Assess current code-change risk and recommend review/verification level. Read-only.'

const PROMPT = `Inspect the current git diff or explicit changed files and return a risk-based review and verification recommendation. This tool is read-only and never runs tests, edits files, or spawns agents.

Use after non-trivial edits, before finalizing risky work, or when deciding whether to run reviewer/verifier agents. Low-risk changes should not trigger heavy workflows; medium/high risk should get focused review and verification.`

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

const changedFileSchema = z.object({
  path: z.string(),
  status: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
})

const inputSchema = lazySchema(() =>
  z.strictObject({
    root: z
      .string()
      .optional()
      .describe('Repository root or file path to inspect. Defaults to the current working directory.'),
    changedFiles: z
      .array(z.string())
      .max(200)
      .optional()
      .describe('Optional explicit changed files when git status is unavailable or incomplete.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    root: z.string(),
    isGitRepo: z.boolean(),
    changedFiles: z.array(changedFileSchema),
    additions: z.number(),
    deletions: z.number(),
    risk: z.enum(['low', 'medium', 'high']),
    score: z.number(),
    triggers: z.array(z.string()),
    reviewRecommended: z.boolean(),
    verifyRecommended: z.boolean(),
    suggestedChecks: z.array(z.string()),
    notes: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const ChangeRiskTool = buildTool({
  name: CHANGE_RISK_TOOL_NAME,
  searchHint: 'review verify diff risk',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Assessing change risk'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.root ?? ''} ${(input.changedFiles ?? []).join(' ')}`.trim()
  },
  async validateInput(input) {
    if (input.root !== undefined && !input.root.trim()) {
      return {
        result: false,
        message: 'ChangeRisk root must be non-empty when provided.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage(input) {
    return renderText(
      input.root ? `Assessing change risk for ${input.root}` : 'Assessing change risk',
    )
  },
  renderToolResultMessage(output) {
    return renderText(
      `${output.risk} risk, ${output.changedFiles.length} changed file(s)`,
    )
  },
  async call(input) {
    const summary = await collectGitChangeSummary(input.root, input.changedFiles)
    const risk = assessChangeRisk(summary)
    return {
      data: {
        root: summary.root,
        isGitRepo: summary.isGitRepo,
        changedFiles: summary.changedFiles,
        additions: summary.additions,
        deletions: summary.deletions,
        risk: risk.level,
        score: risk.score,
        triggers: risk.triggers,
        reviewRecommended: risk.reviewRecommended,
        verifyRecommended: risk.verifyRecommended,
        suggestedChecks: risk.suggestedChecks,
        notes: risk.notes,
        warnings: summary.warnings,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `Root: ${output.root}`,
      `Git repo: ${output.isGitRepo ? 'yes' : 'no'}`,
      `Changed files: ${output.changedFiles.length}`,
      `Diff size: +${output.additions} -${output.deletions}`,
      `Risk: ${output.risk} (score ${output.score})`,
      `Review recommended: ${output.reviewRecommended ? 'yes' : 'no'}`,
      `Verify recommended: ${output.verifyRecommended ? 'yes' : 'no'}`,
      '',
      'Triggers:',
      ...(output.triggers.length > 0
        ? output.triggers.map(trigger => `- ${trigger}`)
        : ['- none']),
      '',
      'Changed files:',
      ...(output.changedFiles.length > 0
        ? output.changedFiles.slice(0, 80).map(file => {
            const stats =
              file.additions !== undefined || file.deletions !== undefined
                ? ` +${file.additions ?? 0} -${file.deletions ?? 0}`
                : ''
            return `- ${file.path}${file.status ? ` (${file.status})` : ''}${stats}`
          })
        : ['- none']),
      ...(output.changedFiles.length > 80
        ? [`- ... ${output.changedFiles.length - 80} more file(s)`]
        : []),
      '',
      'Suggested checks:',
      ...(output.suggestedChecks.length > 0
        ? output.suggestedChecks.map(check => `- ${check}`)
        : ['- none']),
      ...(output.notes.length > 0
        ? ['', 'Notes:', ...output.notes.map(note => `- ${note}`)]
        : []),
      ...(output.warnings.length > 0
        ? ['', 'Warnings:', ...output.warnings.map(warning => `- ${warning}`)]
        : []),
    ]
    return { type: 'tool_result', tool_use_id: toolUseID, content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
