/**
 * Best-effort, NON-BLOCKING verification of named imports from Node builtin
 * modules after a file edit/write.
 *
 * A class of model mistakes passes every syntax check but fails the moment
 * the code runs: importing a name from the wrong builtin module, e.g.
 * `import { fileURLToPath } from 'node:path'` instead of 'node:url'.
 * Builtins are the one module family we can verify safely and instantly at
 * edit time — requiring them has no side effects and the runtime's own
 * export surface is ground truth. Third-party modules are deliberately NOT
 * loaded (arbitrary code execution, side effects).
 *
 * Same contract as validateEditSyntax: delta-based (only problems the change
 * introduced, so pre-existing issues never nag), advisory-only (the write is
 * never blocked or reverted), and it never throws — any uncertainty resolves
 * to silence.
 */

import { builtinModules, createRequire } from 'node:module'

const requireBuiltin = createRequire(import.meta.url)

// Only JS/TS source files; declaration files are type-context and would
// false-positive on type-only names.
const CHECKED_EXTENSIONS = /\.(?:[mc]?[jt]s|[jt]sx)$/i
const DECLARATION_FILE = /\.d\.(?:[mc]?ts)$/i
const MAX_CHECK_BYTES = 2_000_000

// Requiring these prints deprecation warnings (DEP0040 etc.) — a warn-only
// checker must never pollute the terminal, so they are never loaded.
const NEVER_REQUIRE = new Set(['punycode', 'sys'])

// Bare specifiers ('path', 'fs/promises') that refer to builtins. Entries in
// builtinModules are unprefixed except prefix-only modules ('node:test', …)
// on newer runtimes — normalize both forms.
const builtinNames = new Set(builtinModules.map(m => m.replace(/^node:/, '')))

function isBuiltinSpecifier(spec: string): boolean {
  return spec.startsWith('node:') || builtinNames.has(spec)
}

// Runtime export surface per builtin. null = unloadable on this runtime
// (experimental/unknown) — treated as "cannot verify", i.e. silence.
const exportsCache = new Map<string, Set<string> | null>()

function getBuiltinExports(spec: string): Set<string> | null {
  const bare = spec.replace(/^node:/, '')
  const cached = exportsCache.get(bare)
  if (cached !== undefined) {
    return cached
  }
  let result: Set<string> | null = null
  if (!NEVER_REQUIRE.has(bare) && !bare.startsWith('_')) {
    try {
      // Always require via the node: prefix — resolves prefix-only builtins
      // and can never fall through to a userland package of the same name.
      const mod: unknown = requireBuiltin(`node:${bare}`)
      if (mod && (typeof mod === 'object' || typeof mod === 'function')) {
        result = new Set(Object.keys(mod))
      }
    } catch {
      result = null
    }
  }
  exportsCache.set(bare, result)
  return result
}

// name -> builtin modules exporting it, for "did you mean 'node:url'?".
// Built lazily on the first violation ever found.
let exportNameIndex: Map<string, string[]> | null = null

function modulesExporting(name: string): string[] {
  if (!exportNameIndex) {
    exportNameIndex = new Map()
    for (const m of builtinNames) {
      if (m.startsWith('_') || NEVER_REQUIRE.has(m)) {
        continue
      }
      const exps = getBuiltinExports(m)
      if (!exps) {
        continue
      }
      for (const e of exps) {
        const arr = exportNameIndex.get(e)
        if (arr) {
          arr.push(m)
        } else {
          exportNameIndex.set(e, [m])
        }
      }
    }
  }
  return exportNameIndex.get(name) ?? []
}

type NamedImport = { specifier: string; name: string }

// `import { a, b as c } from 'm'` / `import def, { a } from 'm'`, with an
// optional leading `type` that makes the whole statement type-only.
const IMPORT_RE =
  /\bimport\s+(type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\3/g
// `export { a } from 'm'` — the re-exported name must exist in m.
const EXPORT_RE =
  /\bexport\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\3/g
// `const { a, b: c } = require('m')`
const REQUIRE_RE =
  /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*(['"])([^'"\n]+)\2\s*\)/g

/** Crude comment removal so commented-out imports don't trip the check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')
}

function collectBuiltinNamedImports(source: string): NamedImport[] {
  const found: NamedImport[] = []
  const add = (
    typeKeyword: string | undefined,
    names: string,
    specifier: string,
    viaRequire: boolean,
  ): void => {
    if (typeKeyword || !isBuiltinSpecifier(specifier)) {
      return
    }
    for (const raw of names.split(',')) {
      const entry = raw.trim()
      if (!entry || entry.startsWith('type ')) {
        continue
      }
      // `orig as alias` / `orig: alias` / `orig = default` — the module must
      // export the LEFT side.
      const name = entry
        .split(viaRequire ? /[:=]/ : /\s+as\s+|=/)[0]!
        .trim()
      if (name === 'default' || !/^[A-Za-z_$][\w$]*$/.test(name)) {
        continue
      }
      found.push({ specifier, name })
    }
  }
  const cleaned = stripComments(source)
  for (const m of cleaned.matchAll(IMPORT_RE)) {
    add(m[1], m[2]!, m[4]!, false)
  }
  for (const m of cleaned.matchAll(EXPORT_RE)) {
    add(m[1], m[2]!, m[4]!, false)
  }
  for (const m of cleaned.matchAll(REQUIRE_RE)) {
    add(undefined, m[1]!, m[3]!, true)
  }
  return found
}

function findInvalidImports(source: string): NamedImport[] {
  const invalid: NamedImport[] = []
  for (const imp of collectBuiltinNamedImports(source)) {
    const exports = getBuiltinExports(imp.specifier)
    if (exports && !exports.has(imp.name)) {
      invalid.push(imp)
    }
  }
  return invalid
}

const pairKey = (i: NamedImport): string =>
  `${i.specifier.replace(/^node:/, '')}\0${i.name}`

/**
 * Returns a short advisory string iff the change introduced named imports of
 * builtin modules that the runtime says don't exist, else `undefined`.
 * Never throws.
 */
export function validateBuiltinImports(
  filePath: string,
  before: string,
  after: string,
): string | undefined {
  try {
    if (!CHECKED_EXTENSIONS.test(filePath) || DECLARATION_FILE.test(filePath)) {
      return undefined
    }
    if (
      after.length > MAX_CHECK_BYTES ||
      before.length > MAX_CHECK_BYTES
    ) {
      return undefined
    }

    const bad = findInvalidImports(after)
    if (bad.length === 0) {
      return undefined
    }

    // Delta: pre-existing wrong imports were not caused by this change.
    const preexisting = new Set(findInvalidImports(before).map(pairKey))
    const seen = new Set<string>()
    const issues: string[] = []
    for (const imp of bad) {
      const key = pairKey(imp)
      if (preexisting.has(key) || seen.has(key)) {
        continue
      }
      seen.add(key)
      const bare = imp.specifier.replace(/^node:/, '')
      const suggestions = modulesExporting(imp.name)
        .filter(m => m !== bare)
        .slice(0, 2)
      const hint =
        suggestions.length > 0
          ? ` — did you mean ${suggestions.map(s => `'node:${s}'`).join(' or ')}?`
          : '.'
      issues.push(`'${imp.name}' is not a runtime export of 'node:${bare}'${hint}`)
    }
    if (issues.length === 0) {
      return undefined
    }
    return `⚠ Import check: ${issues.join(' ')} The change was still applied. A value import of a missing name throws at runtime; if the name is only used as a type, write it as \`import type\` instead. (Checked against this machine's runtime.)`
  } catch {
    return undefined
  }
}
