/**
 * Bash failure guidance unit tests.
 *
 * Run: bun run src/tools/BashTool/bashFailureGuidance.test.ts
 */

import {
  appendBashFailureGuidance,
  buildBashFailureGuidance,
} from './bashFailureGuidance.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function main(): void {
  console.log('bash failure guidance:')

  test('treats command-only output as no diagnostic output', () => {
    const command = 'docker exec namenode hdfs dfs -ls /'
    const guidance = buildBashFailureGuidance(command, 1, command)

    assert(
      guidance.includes('without diagnostic output'),
      `expected no-diagnostic guidance, got: ${guidance}`,
    )
    assert(
      guidance.includes('Do not retry near-identical commands'),
      'expected retry-loop guidance',
    )
  })

  test('locked-file guidance on POSIX uses native lsof/fuser and targeted kill', () => {
    const guidance = buildBashFailureGuidance(
      'rm -f data/app.db',
      1,
      "rm: cannot remove 'data/app.db': Device or resource busy",
      undefined,
      'linux',
    )
    assert(
      guidance.includes('held by a running process'),
      `expected lock reason, got: ${guidance}`,
    )
    assert(
      guidance.includes('lsof') && guidance.includes('fuser'),
      'expected native POSIX lookup tools',
    )
    assert(
      guidance.includes('never kill every process of an image name'),
      'expected targeted-kill guidance',
    )
    assert(
      !guidance.includes('Stop-Process'),
      'POSIX guidance must not suggest PowerShell cmdlets',
    )
  })

  test('locked-file guidance on Windows avoids lsof and uses doubled-slash flags', () => {
    const guidance = buildBashFailureGuidance(
      'rm app.db',
      1,
      'The process cannot access the file because it is being used by another process.',
      undefined,
      'windows',
    )
    assert(
      guidance.includes('held by a running process'),
      `expected lock reason (not not-found), got: ${guidance}`,
    )
    assert(
      guidance.includes('tasklist //FI') && guidance.includes('Stop-Process'),
      'expected Windows-native lookup with doubled slashes',
    )
    assert(
      guidance.includes('no lsof/fuser'),
      'must warn that Git Bash lacks lsof/fuser',
    )
    assert(
      guidance.includes('run_in_background'),
      'expected tracked-background recommendation',
    )
  })

  test('redirects Windows-only tools to native equivalents on POSIX hosts', () => {
    const guidance = buildBashFailureGuidance(
      'tasklist /FI "PID eq 123"',
      127,
      'bash: tasklist: command not found',
      undefined,
      'linux',
    )
    assert(
      guidance.includes('Windows-only tools'),
      `expected Windows-only redirect, got: ${guidance}`,
    )
    assert(
      guidance.includes('ps aux') && guidance.includes('kill <PID>'),
      'expected native process tool suggestions',
    )
  })

  test('redirects lsof/fuser to PowerShell equivalents on Windows hosts', () => {
    const guidance = buildBashFailureGuidance(
      'lsof -i :8080',
      127,
      'bash: lsof: command not found',
      undefined,
      'windows',
    )
    assert(
      guidance.includes('not available in Git Bash'),
      `expected Git Bash limitation note, got: ${guidance}`,
    )
    assert(
      guidance.includes('Get-NetTCPConnection'),
      'expected PowerShell port lookup suggestion',
    )
  })

  test('still classifies plain missing files as not found', () => {
    const guidance = buildBashFailureGuidance(
      'ls data/app.db',
      2,
      "ls: cannot access 'data/app.db': No such file or directory",
    )
    assert(
      guidance.includes('was not found'),
      `expected not-found reason, got: ${guidance}`,
    )
  })

  test('includes Ran in line when execution dir is provided', () => {
    const guidance = buildBashFailureGuidance(
      'node server.js',
      1,
      "Error: Cannot find module 'C:\\Workspace\\app\\server.js'",
      'C:\\Workspace\\app',
    )
    assert(
      guidance.includes('- Ran in: C:\\Workspace\\app'),
      `expected Ran in line, got: ${guidance}`,
    )
  })

  test('omits Ran in line when execution dir is not provided', () => {
    const guidance = buildBashFailureGuidance('false', 1, '')
    assert(!guidance.includes('- Ran in:'), 'must omit Ran in line')
  })

  test('not-found guidance points at explicit paths or native flags', () => {
    const guidance = buildBashFailureGuidance(
      'node server.js',
      1,
      'Error: ENOENT: no such file or directory',
      '/c/workspace/app',
    )
    assert(
      guidance.includes('absolute path') && guidance.includes('native location/config flag'),
      `expected explicit path guidance, got: ${guidance}`,
    )
    assert(
      !guidance.includes('workdir parameter'),
      `must not steer toward workdir, got: ${guidance}`,
    )
  })

  test('classifies missing file diagnostics generically', () => {
    const guidance = buildBashFailureGuidance(
      'cat /missing/file',
      1,
      'cat: /missing/file: No such file or directory',
    )

    assert(
      guidance.includes('not found'),
      `expected not-found reason, got: ${guidance}`,
    )
    assert(
      guidance.includes('list the parent location'),
      'expected diagnostic next step',
    )
  })

  test('classifies runtime output encoding failures', () => {
    const guidance = buildBashFailureGuidance(
      'python read_pdf.py',
      1,
      "UnicodeEncodeError: 'charmap' codec can't encode character '\\u202f'",
    )

    assert(
      guidance.includes('encoding text for stdout or stderr'),
      `expected encoding reason, got: ${guidance}`,
    )
    assert(
      guidance.includes('PYTHONIOENCODING=utf-8'),
      'expected Python UTF-8 guidance',
    )
  })

  test('adds Python-specific diagnostics when output is missing', () => {
    const command = 'python read_pdf.py'
    const guidance = buildBashFailureGuidance(command, 1, command)

    assert(
      guidance.includes('sys.stdout.encoding'),
      `expected Python encoding diagnostic guidance, got: ${guidance}`,
    )
  })

  test('adds pipeline diagnostics for failed pipelines', () => {
    const guidance = buildBashFailureGuidance(
      'cat missing.txt | sort',
      1,
      'cat: missing.txt: No such file or directory',
    )

    assert(
      guidance.includes('set -o pipefail'),
      `expected pipefail guidance, got: ${guidance}`,
    )
  })

  test('adds stderr capture hint when repeated redirection is present', () => {
    const guidance = buildBashFailureGuidance(
      'python read_pdf.py 2>&1',
      1,
      'python read_pdf.py 2>&1',
    )

    assert(
      guidance.includes('already captures stderr'),
      `expected stderr capture guidance, got: ${guidance}`,
    )
  })

  test('adds Windows Bash path guidance', () => {
    const guidance = buildBashFailureGuidance(
      'cd "C:\\Projects\\Hadoop"',
      1,
      'bash: cd: C:ProjectsHadoop: No such file or directory',
    )

    assert(
      guidance.includes('prefer C:/path or /c/path'),
      `expected Windows Bash path guidance, got: ${guidance}`,
    )
  })

  test('adds project-root diagnostics for cd plus npm commands', () => {
    const guidance = buildBashFailureGuidance(
      'cd frontend && npm run build',
      1,
      'bash: cd: frontend: No such file or directory',
    )

    assert(
      guidance.includes('verify the active cwd and target'),
      `expected cwd target guidance, got: ${guidance}`,
    )
    assert(
      guidance.includes('find .. -maxdepth 4 -name package.json'),
      `expected project manifest search guidance, got: ${guidance}`,
    )
  })

  test('adds project-root diagnostics even without command output', () => {
    const guidance = buildBashFailureGuidance(
      'cd frontend && npm run build',
      1,
      '',
    )

    assert(
      guidance.includes('Resolve the project root'),
      `expected project-root guidance, got: ${guidance}`,
    )
  })

  test('classifies missing runtime dependencies', () => {
    const guidance = buildBashFailureGuidance(
      'node app.js',
      1,
      "Error: Cannot find module 'express'",
    )

    assert(
      guidance.includes('required module or dependency'),
      `expected dependency guidance, got: ${guidance}`,
    )
  })

  test('classifies interactive terminal failures', () => {
    const guidance = buildBashFailureGuidance(
      'docker exec -it namenode bash',
      1,
      'the input device is not a TTY',
    )

    assert(
      guidance.includes('interactive terminal'),
      `expected TTY guidance, got: ${guidance}`,
    )
  })

  test('adds inline-code quoting guidance even when the evaluator is silent', () => {
    const guidance = buildBashFailureGuidance(
      'runtime --eval "fn({_id:"value"})"',
      1,
      '',
      undefined,
      'windows',
    )
    assert(
      guidance.includes('receives the program as one argument'),
      `expected inline evaluator guidance, got: ${guidance}`,
    )
  })

  test('distinguishes host and remote temp files on Windows', () => {
    const guidance = buildBashFailureGuidance(
      'docker cp /tmp/init.js app:/tmp/init.js',
      1,
      'The system cannot find the file specified',
      undefined,
      'windows',
    )
    assert(
      guidance.includes('native per-user host temp directory'),
      `expected local temp guidance, got: ${guidance}`,
    )
    assert(
      guidance.includes('container/VM /tmp is a different filesystem'),
      `expected boundary distinction, got: ${guidance}`,
    )
  })

  test('classifies Windows MSYS remote-path conversion failures', () => {
    const guidance = buildBashFailureGuidance(
      'docker exec namenode hadoop fs -cat /bigdata/hello.txt',
      1,
      'cat: No FileSystem for scheme "C"',
      undefined,
      'windows',
    )

    assert(
      guidance.includes('Windows/MSYS process boundary'),
      `expected MSYS path-conversion reason, got: ${guidance}`,
    )
    assert(
      guidance.includes('not a syntax or Compose-file-location error'),
      `expected root-cause correction, got: ${guidance}`,
    )
    assert(
      guidance.includes('quoted sh -c/bash -c'),
      `expected protected remote command guidance, got: ${guidance}`,
    )
  })

  test('steers config-in-cwd tools (dvc) to explicit absolute location', () => {
    const guidance = buildBashFailureGuidance(
      'dvc repro',
      253,
      "ERROR: failed to reproduce 'dvc.yaml': '/wrong/dir/dvc.yaml' does not exist",
      '/c/Users/ok/Desktop/Devoir_Big_Data',
    )
    assert(
      guidance.includes('resolves its project/config from the working directory'),
      `expected config-in-cwd hint, got: ${guidance}`,
    )
    assert(
      guidance.includes('ABSOLUTE path encoded in the command') &&
        guidance.includes('docker compose -f') &&
        guidance.includes('terraform -chdir') &&
        guidance.includes('npm --prefix'),
      `expected explicit-location steering for dvc, got: ${guidance}`,
    )
    assert(
      !guidance.includes('workdir parameter'),
      `must not steer toward workdir, got: ${guidance}`,
    )
  })

  test('does not add the config-in-cwd hint for unrelated docker subcommands', () => {
    const guidance = buildBashFailureGuidance(
      'docker exec namenode hdfs dfs -ls /',
      1,
      'Error response from daemon: No such container: namenode',
    )
    assert(
      !guidance.includes('resolves its project/config from the working directory'),
      'docker exec must not trigger the compose/config-in-cwd hint',
    )
  })

  test('appends guidance once', () => {
    const once = appendBashFailureGuidance('false', 1, '')
    const twice = appendBashFailureGuidance('false', 1, once)

    assert(once === twice, 'guidance should not duplicate')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
