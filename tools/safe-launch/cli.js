#!/usr/bin/env node
'use strict';

const { parseArgs, safeLaunch } = require('./lib/launcher');

function printHelp() {
  process.stdout.write(
    [
      'agy-safe-launch — Completely detached launcher (zero pipe inheritance, zero Empty-log hangs)',
      '',
      'Usage:',
      '  node cli.js [options] -- <command> [args...]',
      '',
      'Options:',
      '  --cwd <dir>         Working directory for the child process',
      '  --kill-name <name>  Stop existing matching processes before launching',
      '  --wait-port <port>  Wait until TCP port accepts connections',
      '  --wait-host <host>  Host for --wait-port (default: 127.0.0.1)',
      '  --wait-ms <ms>      Max wait time for --wait-port (default: 15000)',
      '  --no-strict-port    Exit 0 even if --wait-port does not become ready in time',
      '  --hide              Hide console window (windowsHide: true)',
      '  --env KEY=VALUE     Extra environment variable (repeatable)',
      '  -h, --help          Show this help',
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
    const result = await safeLaunch(opts);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: err && err.message ? err.message : String(err),
      }) + '\n',
    );
    process.exit(1);
  }
}

main();
