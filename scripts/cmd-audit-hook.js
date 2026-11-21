#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  try {
    const raw = (await readStdin()).replace(/^\uFEFF/, '');
    if (raw && raw.trim()) {
      const payload = JSON.parse(raw);
      const tc = (payload && payload.toolCall) || {};
      const err = payload && payload.error ? String(payload.error) : '';
      if (err) {
        const dataDir = process.env.PLUGIN_DATA || path.join(os.tmpdir(), 'agy-unstick-audit');
        fs.mkdirSync(dataDir, { recursive: true });
        const entry = {
          at: new Date().toISOString(),
          conversationId: payload.conversationId || null,
          stepIdx: payload.stepIdx ?? null,
          commandLine: tc.args && (tc.args.CommandLine || tc.args.command) ? String(tc.args.CommandLine || tc.args.command).slice(0, 240) : '',
          error: err.slice(0, 240),
        };
        fs.appendFileSync(path.join(dataDir, 'run-command-errors.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
      }
    }
  } catch {
    // Ignore audit write errors so PostToolUse never interrupts the workflow.
  }
  process.stdout.write('{}\n');
}

main();
