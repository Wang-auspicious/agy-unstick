#!/usr/bin/env node
'use strict';

const { parseArgs, safeRun } = require('./lib/runner');

function printHelp() {
  process.stdout.write(
    [
      'agy-safe-run — Streaming timeout wrapper with full process-tree cleanup & bounded logs',
      '',
      'Usage:',
      '  node cli.js [--timeout 120] [--max-lines 200] [--cwd <dir>] [--shell powershell|cmd|sh] -- <command>',
      '',
      'Options:',
      '  -t, --timeout <sec>  Hard timeout in seconds before killing process tree (default: 120)',
      '  --max-lines <n>      Max stdout lines printed inline; middle overflow goes to temp log (default: 200)',
      '  --cwd <dir>          Working directory',
      '  --shell <type>       powershell | pwsh | cmd | sh (defaults to powershell on Windows, sh on POSIX)',
      '  -h, --help           Show this help',
    ].join('\n') + '\n',
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.command) {
    printHelp();
    process.exit(opts.help ? 0 : 2);
  }
  try {
    const result = await safeRun(opts);
    process.exit(result.exitCode);
  } catch (err) {
    process.stderr.write(`[agy-safe-run] Error: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main();
