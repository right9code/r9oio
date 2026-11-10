#!/usr/bin/env node
/**
 * Tau preinstall — clears dangling global bin shims before npm links bins.
 *
 * When a previous global update was interrupted (EPERM cleanup on Windows,
 * Ctrl-C, antivirus locks), npm can lose track of the `tau` / `claudex`
 * shims it created earlier. The next `npm install -g` then aborts with:
 *
 *   npm error code EEXIST
 *   npm error File exists: C:\Users\...\npm\claudex
 *
 * npm runs this script after extracting the package but BEFORE linking bin
 * shims. Only launchers whose embedded target no longer exists are removed.
 * In particular, a healthy launcher owned by the previous Tau installation
 * stays in place until npm successfully replaces it, so a failed update does
 * not needlessly remove the user's working `tau` / `claudex` command. A shim
 * owned by another package is preserved and gets a warning instead.
 *
 * Never fails the install: every path is wrapped and the script exits 0.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN_NAMES = ['tau', 'claudex'];
const WIN_EXTS = ['', '.cmd', '.ps1'];

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function getPackageName() {
  try {
    return JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ).name;
  } catch {
    return '@right9/oio';
  }
}

/**
 * For a global install, this package lives at <prefix>/(lib/)node_modules/
 * <scope>/<name>. Walk up to the node_modules dir to find the bin dir:
 * on Windows the prefix itself, elsewhere <prefix>/bin.
 */
function getGlobalBinDir() {
  // packageRoot = .../node_modules/@scope/name → up 2 = node_modules
  const nodeModules = resolve(packageRoot, '..', '..');
  if (basename(nodeModules) !== 'node_modules') return null; // dev repo / npm link
  const prefixOrLib = dirname(nodeModules);
  if (process.platform === 'win32') {
    // %APPDATA%\npm\node_modules → bin shims live in %APPDATA%\npm
    return prefixOrLib;
  }
  // <prefix>/lib/node_modules → <prefix>/bin ; <prefix>/node_modules → <prefix>/bin
  const prefix =
    basename(prefixOrLib) === 'lib' ? dirname(prefixOrLib) : prefixOrLib;
  return join(prefix, 'bin');
}

/** Resolve targets from npm's quoted sh/cmd/ps1 launcher templates. */
function getEmbeddedShimTargets(shimPath, content) {
  const quotedTargets = [
    ...content.matchAll(/"([^"\r\n]*node_modules\/[^"\r\n]+)"/g),
    ...content.matchAll(/'([^'\r\n]*node_modules\/[^'\r\n]+)'/g),
  ];
  const basedirPrefix =
    /^(?:%~dp0%?|%dp0%|\$(?:basedir|\{basedir\}|PSScriptRoot|\{PSScriptRoot\}))(?:\/|$)/i;

  return quotedTargets.flatMap((match) => {
    let embeddedPath = match[1];
    if (!embeddedPath) return [];

    if (basedirPrefix.test(embeddedPath)) {
      embeddedPath = embeddedPath.replace(
        basedirPrefix,
        `${dirname(shimPath)}/`,
      );
    } else if (/[$%`]/.test(embeddedPath)) {
      // An unknown shell variable means we cannot prove where this points.
      return [];
    }

    return [resolve(dirname(shimPath), embeddedPath)];
  });
}

/** Does this shim/symlink belong to us, or point at nothing? */
export function classifyShim(shimPath, packageName) {
  try {
    const stat = lstatSync(shimPath);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(shimPath);
      const resolved = resolve(dirname(shimPath), target);
      if (!existsSync(resolved)) return 'dangling';
      const normalized = resolved.split('\\').join('/');
      return normalized.includes(`node_modules/${packageName}/`)
        ? 'ours'
        : 'foreign';
    }
    // Resolve npm's complete quoted target, including absolute/relative
    // prefixes. Preserve custom launchers whose shell variables are unknown.
    const content = readFileSync(shimPath, 'utf8').split('\\').join('/');
    const targets = getEmbeddedShimTargets(shimPath, content);
    let hasMissingTarget = false;
    for (const target of targets) {
      if (!existsSync(target)) {
        hasMissingTarget = true;
        continue;
      }
      const normalized = target.split('\\').join('/');
      if (normalized.includes(`node_modules/${packageName}/`)) return 'ours';
      return 'foreign';
    }
    return hasMissingTarget ? 'dangling' : 'foreign';
  } catch {
    return 'unknown';
  }
}

export function cleanDanglingBinShims(
  binDir,
  packageName,
  platform = process.platform,
) {
  if (!binDir || !existsSync(binDir)) return;
  const exts = platform === 'win32' ? WIN_EXTS : [''];

  for (const name of BIN_NAMES) {
    for (const ext of exts) {
      const shimPath = join(binDir, name + ext);
      try {
        if (!lstatSync(shimPath)) continue;
      } catch {
        continue; // doesn't exist
      }

      const kind = classifyShim(shimPath, packageName);
      if (kind === 'dangling') {
        try {
          unlinkSync(shimPath);
          console.log(
            `[tau] Removed dangling '${name}${ext}' launcher left by a previous install`,
          );
        } catch {
          // npm may still EEXIST; the error message tells the user what to delete.
        }
      } else if (kind === 'foreign') {
        console.warn(
          `[tau] Warning: '${shimPath}' belongs to another package. ` +
            `If this install fails with EEXIST, remove that package first ` +
            `(npm ls -g, then npm uninstall -g <package>).`,
        );
      }
    }
  }
}

function main() {
  const binDir = getGlobalBinDir();
  if (!binDir || !existsSync(binDir)) return; // not a global install
  cleanDanglingBinShims(binDir, getPackageName());
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch {
    // Never block the install.
  }
  process.exit(0);
}
