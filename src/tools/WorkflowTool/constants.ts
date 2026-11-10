// WorkflowTool itself is feature-gated (WORKFLOW_SCRIPTS) and not part of
// this build; the tool module resolves to the build shim. Only the name
// constant lives here so modules that reference it (constants/tools.ts)
// resolve under bun test, where the build-time shim doesn't exist.
export const WORKFLOW_TOOL_NAME = 'Workflow'
