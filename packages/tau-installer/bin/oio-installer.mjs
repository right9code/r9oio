#!/usr/bin/env node

import { HELP_TEXT, parseArguments, runInstaller } from "../lib/installer.mjs";

async function main() {
  let options;

  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`tau-installer: ${error.message}\n\n${HELP_TEXT}`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  return runInstaller(options);
}

process.exitCode = await main();
