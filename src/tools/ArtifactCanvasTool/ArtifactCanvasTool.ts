import { join } from 'path'
import { marked } from 'marked'
import { createElement } from 'react'
import xss from 'xss'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { openPath } from '../../utils/browser.js'
import { pathToLocalFileUrl } from '../../utils/fileUrls.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  ensureArtifactDir,
  htmlEscape,
  resolveArtifactDir,
  slugifyArtifactTitle,
  uniqueArtifactSlug,
  writeArtifactFile,
} from '../shared/htmlArtifacts.js'
import { ARTIFACT_CANVAS_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  'Write a browser-reviewable artifact canvas for HTML, Markdown, JSON, or text.'

const PROMPT = `Create a local artifact canvas: a standalone HTML file that can be opened in a browser.

Use when work needs a durable visual artifact, preview, report, mockup, or comparison surface. Keep the canvas focused on the requested artifact, not a marketing page. The tool writes under .tau/artifacts by default and returns absolute file paths plus canonical file:// URLs for browser tools.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    title: z.string().min(1).describe('Artifact title and filename hint.'),
    kind: z
      .enum(['markdown', 'html', 'json', 'text'])
      .describe('Content format. HTML is rendered in a sandboxed preview frame.'),
    content: z.string().min(1).describe('Artifact source content.'),
    outputDir: z
      .string()
      .optional()
      .describe('Output directory. Defaults to .tau/artifacts.'),
    open: z
      .boolean()
      .optional()
      .describe('Open the generated HTML file with the OS default browser. Defaults to false.'),
    overwrite: z
      .boolean()
      .optional()
      .describe('Overwrite files with the same slug. Defaults to false.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    title: z.string(),
    kind: z.enum(['markdown', 'html', 'json', 'text']),
    htmlPath: z.string(),
    htmlUrl: z.string(),
    sourcePath: z.string(),
    sourceUrl: z.string(),
    opened: z.boolean(),
    bytes: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function renderText(message: string): React.ReactNode {
  return createElement(Text, null, message)
}

function sourceExtension(kind: z.infer<InputSchema>['kind']): string {
  if (kind === 'markdown') return '.md'
  if (kind === 'json') return '.json'
  if (kind === 'html') return '.fragment.html'
  return '.txt'
}

function normalizeJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return content
  }
}

function renderBody(kind: z.infer<InputSchema>['kind'], content: string): string {
  if (kind === 'html') {
    return `<iframe class="html-frame" sandbox="allow-scripts allow-forms allow-popups-by-user-activation" referrerpolicy="no-referrer" srcdoc="${htmlEscape(content)}"></iframe>`
  }
  if (kind === 'markdown') return xss(marked.parse(content, { async: false }) as string)
  if (kind === 'json') {
    return `<pre class="artifact-pre">${htmlEscape(normalizeJson(content))}</pre>`
  }
  return `<pre class="artifact-pre">${htmlEscape(content)}</pre>`
}

function buildHtml(title: string, kind: z.infer<InputSchema>['kind'], content: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f5; color: #181816; }
    .shell { max-width: 1120px; margin: 0 auto; padding: 32px 24px 56px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; border-bottom: 1px solid #d9d9d2; padding-bottom: 14px; margin-bottom: 24px; }
    h1 { font-size: 24px; line-height: 1.2; margin: 0; font-weight: 700; }
    .meta { color: #66665f; font-size: 13px; }
    .canvas { background: #ffffff; border: 1px solid #d9d9d2; border-radius: 8px; padding: 24px; overflow: auto; }
    .canvas.html-canvas { padding: 0; overflow: hidden; }
    .html-frame { display: block; width: 100%; min-height: 78vh; border: 0; background: #ffffff; }
    .artifact-pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 13px; line-height: 1.5; margin: 0; }
    img, video, canvas, svg { max-width: 100%; height: auto; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #d9d9d2; padding: 8px 10px; vertical-align: top; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    @media (prefers-color-scheme: dark) {
      body { background: #181816; color: #f1f1ed; }
      header, .canvas, th, td { border-color: #3a3a34; }
      .canvas { background: #20201d; }
      .meta { color: #aaa99f; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <h1>${htmlEscape(title)}</h1>
      <div class="meta">${htmlEscape(kind)} artifact</div>
    </header>
    <section class="canvas${kind === 'html' ? ' html-canvas' : ''}">
${renderBody(kind, content)}
    </section>
  </main>
</body>
</html>
`
}

export const ArtifactCanvasTool = buildTool({
  name: ARTIFACT_CANVAS_TOOL_NAME,
  searchHint: 'artifact canvas html preview',
  maxResultSizeChars: 20_000,
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
    return 'Creating artifact'
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe(input) {
    return input.overwrite !== true
  },
  isDestructive(input) {
    return input.overwrite === true
  },
  toAutoClassifierInput(input) {
    return `${input.kind} ${input.title} ${input.outputDir ?? ''}`.trim()
  },
  renderToolUseMessage(input) {
    return renderText(`Creating artifact ${input.title ?? ''}`.trim())
  },
  renderToolResultMessage(output) {
    return renderText(`Wrote ${output.htmlPath}`)
  },
  async call(input) {
    const dir = resolveArtifactDir(input.outputDir, 'artifacts')
    ensureArtifactDir(dir)
    const baseSlug = slugifyArtifactTitle(input.title, 'artifact')
    const sourceExt = sourceExtension(input.kind)
    const slug = uniqueArtifactSlug(dir, baseSlug, ['.html', sourceExt], input.overwrite)
    const sourcePath = join(dir, `${slug}${sourceExt}`)
    const htmlPath = join(dir, `${slug}.html`)
    const sourceContent = input.kind === 'json' ? normalizeJson(input.content) : input.content
    const html = buildHtml(input.title, input.kind, input.content)

    writeArtifactFile(sourcePath, sourceContent)
    writeArtifactFile(htmlPath, html)

    const opened = input.open === true ? await openPath(htmlPath) : false
    return {
      data: {
        title: input.title,
        kind: input.kind,
        htmlPath,
        htmlUrl: pathToLocalFileUrl(htmlPath),
        sourcePath,
        sourceUrl: pathToLocalFileUrl(sourcePath),
        opened,
        bytes: html.length,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: [
        `Artifact canvas: ${output.title}`,
        `Kind: ${output.kind}`,
        `HTML: ${output.htmlPath}`,
        `HTML URL: ${output.htmlUrl}`,
        `Source: ${output.sourcePath}`,
        `Source URL: ${output.sourceUrl}`,
        `Opened: ${output.opened ? 'yes' : 'no'}`,
      ].join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
