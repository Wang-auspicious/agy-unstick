#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { getDefaultBrainDir, scanAllSessions, scanSession } = require('./lib/scanner');

function printUsage() {
  process.stdout.write(
    [
      'agy-task-doctor — 0-Token Antigravity background task & Empty-log hang forensics',
      '',
      'Usage:',
      '  node cli.js scan [--days 7] [--limit 50] [--json] [--brain <dir>]',
      '  node cli.js session <id-prefix> [--json] [--brain <dir>]',
      '  node cli.js stats [--days 30] [--brain <dir>]',
    ].join('\n') + '\n',
  );
}

function formatScanReport(report) {
  const lines = [
    `[agy-task-doctor] Brain: ${report.brainDir}`,
    `Scanned ${report.sessionsScanned} recent session(s) (last ${report.days}d): found ${report.totalFindings} Empty-log / canceled background task incident(s) across ${report.affectedSessions.length} session(s).`,
  ];
  const causes = Object.entries(report.causeCounts);
  if (causes.length > 0) {
    lines.push('Cause breakdown: ' + causes.map(([k, v]) => `${k}=${v}`).join(', '));
  }
  lines.push('');
  for (const sess of report.affectedSessions) {
    lines.push(`Session ${sess.sessionId} (${sess.findings.length}/${sess.totalTasks} tasks):`);
    for (const f of sess.findings) {
      const tags = [f.emptyLog ? 'EMPTY_LOG' : null, f.canceled ? 'CANCELED' : null].filter(Boolean).join('+');
      lines.push(`  - ${f.taskId} [${tags}] @ ${f.mtimeIso} | cause=${f.cause}`);
      if (f.sampleCommand) {
        lines.push(`    cmd: ${f.sampleCommand.replace(/\s+/g, ' ').trim()}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printUsage();
    process.exit(0);
  }

  let days = sub === 'stats' ? 30 : 7;
  let limit = 50;
  let asJson = false;
  let brainDir = getDefaultBrainDir();
  const rest = [];

  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--days' && argv[i + 1]) days = Number(argv[++i]);
    else if (tok === '--limit' && argv[i + 1]) limit = Number(argv[++i]);
    else if (tok === '--brain' && argv[i + 1]) brainDir = path.resolve(argv[++i]);
    else if (tok === '--json') asJson = true;
    else rest.push(tok);
  }

  if (sub === 'scan' || sub === 'stats') {
    const report = scanAllSessions({ brainDir, days, limit });
    if (asJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(formatScanReport(report));
    }
    process.exit(0);
  }

  if (sub === 'session') {
    const prefix = rest[0];
    if (!prefix) {
      process.stderr.write('Missing session id or prefix.\n');
      process.exit(2);
    }
    if (!fs.existsSync(brainDir)) {
      process.stderr.write(`Brain directory not found: ${brainDir}\n`);
      process.exit(1);
    }
    const match = fs
      .readdirSync(brainDir, { withFileTypes: true })
      .find((d) => d.isDirectory() && d.name.toLowerCase().startsWith(prefix.toLowerCase()));
    if (!match) {
      process.stderr.write(`No session directory matches prefix "${prefix}".\n`);
      process.exit(1);
    }
    const res = scanSession(path.join(brainDir, match.name)) || {
      sessionId: match.name,
      findings: [],
      totalTasks: 0,
    };
    process.stdout.write(
      asJson
        ? JSON.stringify(res, null, 2) + '\n'
        : formatScanReport({
            brainDir,
            days: 365,
            sessionsScanned: 1,
            affectedSessions: res.findings.length ? [res] : [],
            totalFindings: res.findings.length,
            causeCounts: {},
          }),
    );
    process.exit(0);
  }

  printUsage();
  process.exit(2);
}

main();
