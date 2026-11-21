'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // Process may have already exited.
  }
}

function buildShellInvocation(command, shellKind) {
  const chosen = (shellKind || (process.platform === 'win32' ? 'powershell' : 'sh')).toLowerCase();
  if (chosen === 'powershell' || chosen === 'pwsh') {
    const exe = chosen === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
    const trimmed = String(command || '').trim();
    const psCmd = /^"[^"]+\.exe"\s+/i.test(trimmed) ? `& ${trimmed}` : trimmed;
    return {
      exe,
      args: ['-NoProfile', '-NonInteractive', '-Command', psCmd],
    };
  }
  if (chosen === 'cmd') {
    return {
      exe: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }
  return {
    exe: '/bin/sh',
    args: ['-c', command],
  };
}

function createBoundedStreamer({ maxLines, onWrite }) {
  const limit = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : 200;
  const headQuota = Math.max(1, Math.floor(limit / 2));
  const tailQuota = Math.max(1, limit - headQuota);

  let totalLines = 0;
  let headCount = 0;
  const tailRing = [];
  let overflowFile = null;
  let overflowStream = null;
  let remainder = '';

  function ensureOverflowLog() {
    if (overflowStream) return;
    const logDir = path.join(os.tmpdir(), 'agy-unstick-logs');
    fs.mkdirSync(logDir, { recursive: true });
    overflowFile = path.join(logDir, `run-${Date.now()}-${process.pid}.log`);
    overflowStream = fs.createWriteStream(overflowFile, { encoding: 'utf8' });
  }

  function pushLine(line) {
    totalLines += 1;
    if (headCount < headQuota) {
      headCount += 1;
      onWrite(line + '\n');
      return;
    }
    ensureOverflowLog();
    overflowStream.write(line + '\n');
    tailRing.push(line);
    if (tailRing.length > tailQuota) {
      tailRing.shift();
    }
  }

  function pushChunk(chunk) {
    const text = remainder + chunk.toString('utf8');
    const parts = text.split(/\r?\n/);
    remainder = parts.pop() || '';
    for (const line of parts) {
      pushLine(line);
    }
  }

  function finish() {
    if (remainder.length > 0) {
      pushLine(remainder);
      remainder = '';
    }
    const omitted = totalLines - headCount - tailRing.length;
    if (omitted > 0) {
      onWrite(`\n... [agy-safe-run truncated ${omitted} middle lines; full tail follows] ...\n`);
    }
    if (tailRing.length > 0) {
      onWrite(tailRing.join('\n') + '\n');
    }
    if (overflowStream) {
      overflowStream.end();
      if (omitted > 0) {
        onWrite(`[agy-safe-run full middle/overflow log saved at: ${overflowFile}]\n`);
      }
    }
    return { totalLines, truncated: omitted > 0, overflowFile };
  }

  return { pushChunk, finish };
}

async function safeRun(options) {
  const command = String(options.command || '').trim();
  if (!command) {
    throw new Error('Missing command string to run.');
  }
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const timeoutSec = Number(options.timeoutSec) > 0 ? Number(options.timeoutSec) : 120;
  const maxLines = Number(options.maxLines) > 0 ? Number(options.maxLines) : 200;
  const inv = buildShellInvocation(command, options.shell);

  const stdoutStreamer = createBoundedStreamer({
    maxLines,
    onWrite: options.onStdout || ((s) => process.stdout.write(s)),
  });
  const stderrStreamer = createBoundedStreamer({
    maxLines: Math.max(40, Math.floor(maxLines / 2)),
    onWrite: options.onStderr || ((s) => process.stderr.write(s)),
  });

  const startedAt = Date.now();
  let timedOut = false;

  const child = spawn(inv.exe, inv.args, {
    cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    shell: false,
  });

  child.stdout.on('data', (chunk) => stdoutStreamer.pushChunk(chunk));
  child.stderr.on('data', (chunk) => stderrStreamer.pushChunk(chunk));

  const timer = setTimeout(() => {
    timedOut = true;
    const errOut = options.onStderr || ((s) => process.stderr.write(s));
    errOut(`\n[agy-safe-run] TIMEOUT after ${timeoutSec}s — killing process tree PID ${child.pid}\n`);
    killProcessTree(child.pid);
  }, timeoutSec * 1000);
  if (typeof timer.unref === 'function') timer.unref();

  const exitInfo = await new Promise((resolve) => {
    let resolved = false;
    const settle = (code, signal, err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ code, signal, error: err ? err.message : null });
    };
    child.once('error', (err) => settle(1, null, err));
    child.once('close', (code, signal) => settle(code, signal, null));
  });

  const outMeta = stdoutStreamer.finish();
  const errMeta = stderrStreamer.finish();

  const exitCode = timedOut ? 124 : typeof exitInfo.code === 'number' ? exitInfo.code : 1;
  return {
    ok: !timedOut && exitCode === 0,
    exitCode,
    timedOut,
    durationMs: Date.now() - startedAt,
    stdoutLines: outMeta.totalLines,
    stderrLines: errMeta.totalLines,
    truncated: outMeta.truncated || errMeta.truncated,
    error: exitInfo.error,
  };
}

function parseArgs(argv) {
  const opts = {
    cwd: undefined,
    timeoutSec: 120,
    maxLines: 200,
    shell: undefined,
    command: '',
    help: false,
  };

  const sepIdx = argv.indexOf('--');
  const flagArgs = sepIdx === -1 ? argv.slice() : argv.slice(0, sepIdx);
  const restArgs = sepIdx === -1 ? [] : argv.slice(sepIdx + 1);
  const positionals = [];

  for (let i = 0; i < flagArgs.length; i++) {
    const tok = flagArgs[i];
    if (tok === '--help' || tok === '-h') {
      opts.help = true;
    } else if (tok === '--cwd' && flagArgs[i + 1]) {
      opts.cwd = flagArgs[++i];
    } else if ((tok === '--timeout' || tok === '-t') && flagArgs[i + 1]) {
      opts.timeoutSec = Number(flagArgs[++i]);
    } else if (tok === '--max-lines' && flagArgs[i + 1]) {
      opts.maxLines = Number(flagArgs[++i]);
    } else if (tok === '--shell' && flagArgs[i + 1]) {
      opts.shell = flagArgs[++i];
    } else {
      positionals.push(tok);
    }
  }

  const cmdParts = [...positionals, ...restArgs];
  opts.command = cmdParts.join(' ').trim();
  return opts;
}

module.exports = {
  safeRun,
  parseArgs,
  killProcessTree,
  createBoundedStreamer,
};
