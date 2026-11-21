'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function expandHome(targetPath) {
  if (!targetPath) return targetPath;
  if (targetPath === '~' || targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    return targetPath === '~' ? home : path.join(home, targetPath.slice(2));
  }
  return targetPath;
}

function killByName(procName) {
  const cleaned = String(procName || '').trim();
  if (!cleaned) return { attempted: false };
  try {
    if (process.platform === 'win32') {
      const imageName = cleaned.toLowerCase().endsWith('.exe') ? cleaned : `${cleaned}.exe`;
      execFileSync('taskkill.exe', ['/F', '/IM', imageName, '/T'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      execFileSync('pkill', ['-f', cleaned], { stdio: 'ignore' });
    }
    return { attempted: true, killed: true };
  } catch (err) {
    // Process not running is expected and non-fatal.
    return { attempted: true, killed: false, detail: err && err.message ? err.message : '' };
  }
}

function probePort(host, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

async function waitForPort(host, port, waitMs) {
  const deadline = Date.now() + Math.max(200, waitMs);
  while (Date.now() < deadline) {
    if (await probePort(host, port, 400)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function isWindowsBatchFile(cmd) {
  const ext = path.extname(String(cmd || '')).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

function resolveCommandPath(rawCommand, cwd) {
  const expanded = expandHome(rawCommand);
  if (expanded && (expanded.includes('/') || expanded.includes('\\'))) {
    return path.isAbsolute(expanded) ? expanded : path.resolve(cwd || process.cwd(), expanded);
  }
  return expanded;
}

async function safeLaunch(options) {
  const cwd = options.cwd ? path.resolve(expandHome(options.cwd)) : process.cwd();
  if (!options.command) {
    throw new Error('Missing target command to launch. Pass `-- <command> [args...]`.');
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }

  let killResult = null;
  if (options.killName) {
    killResult = killByName(options.killName);
  }

  const targetCommand = resolveCommandPath(options.command, cwd);
  const targetArgs = Array.isArray(options.args) ? options.args : [];
  const mergedEnv = { ...process.env, ...(options.env || {}) };

  let spawnCmd = targetCommand;
  let spawnArgs = targetArgs;
  if (process.platform === 'win32' && isWindowsBatchFile(targetCommand)) {
    spawnCmd = process.env.ComSpec || 'cmd.exe';
    spawnArgs = ['/d', '/s', '/c', targetCommand, ...targetArgs];
  }

  const child = spawn(spawnCmd, spawnArgs, {
    cwd,
    env: mergedEnv,
    detached: true,
    stdio: 'ignore',
    windowsHide: options.hide !== false ? Boolean(options.hide) : false,
    shell: false,
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    // spawn emits 'error' asynchronously if executable is missing; yield a tick to catch ENOENT cleanly.
    setImmediate(() => {
      if (settled) return;
      settled = true;
      try {
        child.unref();
      } catch {
        // ignore
      }
      resolve();
    });
  });

  let portReady = null;
  if (options.waitPort) {
    const portNum = Number(options.waitPort);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(`Invalid --wait-port value: ${options.waitPort}`);
    }
    const host = options.waitHost || '127.0.0.1';
    const timeoutMs = Number(options.waitMs) > 0 ? Number(options.waitMs) : 15000;
    portReady = await waitForPort(host, portNum, timeoutMs);
    if (!portReady && options.strictPort !== false) {
      return {
        ok: false,
        pid: child.pid || null,
        command: targetCommand,
        args: targetArgs,
        cwd,
        detached: true,
        killedPrevious: killResult,
        portReady: false,
        error: `Timed out after ${timeoutMs}ms waiting for ${host}:${portNum}`,
      };
    }
  }

  return {
    ok: true,
    pid: child.pid || null,
    command: targetCommand,
    args: targetArgs,
    cwd,
    detached: true,
    ...(killResult ? { killedPrevious: killResult } : {}),
    ...(portReady !== null ? { portReady } : {}),
  };
}

function parseArgs(argv) {
  const sepIdx = argv.indexOf('--');
  const flagArgs = sepIdx === -1 ? argv.slice() : argv.slice(0, sepIdx);
  const restArgs = sepIdx === -1 ? [] : argv.slice(sepIdx + 1);

  const opts = {
    cwd: undefined,
    killName: undefined,
    waitPort: undefined,
    waitHost: '127.0.0.1',
    waitMs: 15000,
    strictPort: true,
    hide: false,
    env: {},
    command: undefined,
    args: [],
    help: false,
  };

  const positionals = [];
  for (let i = 0; i < flagArgs.length; i++) {
    const tok = flagArgs[i];
    if (tok === '--help' || tok === '-h') {
      opts.help = true;
    } else if (tok === '--cwd' && flagArgs[i + 1]) {
      opts.cwd = flagArgs[++i];
    } else if (tok === '--kill-name' && flagArgs[i + 1]) {
      opts.killName = flagArgs[++i];
    } else if (tok === '--wait-port' && flagArgs[i + 1]) {
      opts.waitPort = Number(flagArgs[++i]);
    } else if (tok === '--wait-host' && flagArgs[i + 1]) {
      opts.waitHost = flagArgs[++i];
    } else if (tok === '--wait-ms' && flagArgs[i + 1]) {
      opts.waitMs = Number(flagArgs[++i]);
    } else if (tok === '--no-strict-port') {
      opts.strictPort = false;
    } else if (tok === '--hide') {
      opts.hide = true;
    } else if (tok === '--env' && flagArgs[i + 1]) {
      const pair = flagArgs[++i];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        opts.env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    } else {
      positionals.push(tok);
    }
  }

  const combined = sepIdx === -1 ? positionals : [...positionals, ...restArgs];
  if (combined.length > 0) {
    opts.command = combined[0];
    opts.args = combined.slice(1);
  }
  return opts;
}

module.exports = {
  safeLaunch,
  parseArgs,
  killByName,
  waitForPort,
};
