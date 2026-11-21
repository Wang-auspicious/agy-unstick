'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { evaluateCommand } = require('../scripts/cmd-guard-hook');
const { safeLaunch } = require('../tools/safe-launch/lib/launcher');
const { safeRun } = require('../tools/safe-run/lib/runner');
const { scanAllSessions, classifyHangCause } = require('../tools/task-doctor/lib/scanner');
const { installPlugin, uninstallPlugin, checkStatus } = require('../install');

function killPidBestEffort(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // ignore already exited
  }
}

test('cmd-guard-hook blocks Windows Start-Process pipe-inheritance pattern and suggests safe-launch', () => {
  const verdict = evaluateCommand({
    toolCall: {
      name: 'run_command',
      args: {
        CommandLine:
          'Get-Process "Magic Pointer" | Stop-Process -Force\nStart-Process -FilePath "Magic Pointer.exe" -ArgumentList "--show"\nnode diag.mjs',
        IsDaemon: false,
      },
    },
  });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /safe-launch/);
  assert.match(verdict.reason, /Empty log/);
});

test('cmd-guard-hook blocks cmd /c start, Read-Host, Start-Sleep >=15s, and unmarked dev server', () => {
  const cases = [
    'cmd /c start myapp.exe',
    '$ans = Read-Host "Continue?"',
    'Start-Sleep 45',
    'npm run dev',
    'powershell -Command "Start-Process notepad.exe"',
  ];
  for (const cmd of cases) {
    const verdict = evaluateCommand({
      toolCall: { name: 'run_command', args: { CommandLine: cmd, IsDaemon: false } },
    });
    assert.equal(verdict.decision, 'deny', `Expected deny for: ${cmd}`);
  }
});

test('cmd-guard-hook allows safe builds, Start-Process -Wait, short sleeps, IsDaemon=true, and safe-launch', () => {
  const allowed = [
    { CommandLine: 'npm test', IsDaemon: false },
    { CommandLine: 'git status && npx tsc --noEmit', IsDaemon: false },
    { CommandLine: 'Start-Process -FilePath "installer.exe" -Wait', IsDaemon: false },
    { CommandLine: 'Start-Sleep -Milliseconds 600', IsDaemon: false },
    { CommandLine: 'rg "Start-Process" docs/', IsDaemon: false },
    { CommandLine: 'npm run dev', IsDaemon: true },
    { CommandLine: 'node "C:/plugins/agy-unstick/tools/safe-launch/cli.js" -- node -v', IsDaemon: false },
    { CommandLine: 'node "C:/plugins/agy-unstick/tools/safe-run/cli.js" --timeout 30 -- npm test', IsDaemon: false },
  ];
  for (const args of allowed) {
    const verdict = evaluateCommand({ toolCall: { name: 'run_command', args } });
    assert.equal(verdict.decision, 'allow', `Expected allow for: ${args.CommandLine}`);
  }
});

test('cmd-guard-hook CLI process fails open on malformed stdin JSON', () => {
  const hookPath = path.resolve(__dirname, '../scripts/cmd-guard-hook.js');
  const res = spawnSync(process.execPath, [hookPath], {
    input: '{not valid json',
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout.trim()), { decision: 'allow' });
});

test('safeLaunch detaches child cleanly in <2s without inheriting pipes and waitPort works', async () => {
  const t0 = Date.now();
  const res = await safeLaunch({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 5000)'],
    hide: true,
  });
  try {
    assert.equal(res.ok, true);
    assert.equal(res.detached, true);
    assert.ok(Number.isInteger(res.pid) && res.pid > 0);
    assert.ok(Date.now() - t0 < 2500, 'detached launch must return immediately');
  } finally {
    killPidBestEffort(res.pid);
  }

  // Test waitPort against an ephemeral server
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  let pidToClean = null;
  try {
    const res2 = await safeLaunch({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 2000)'],
      waitHost: '127.0.0.1',
      waitPort: port,
      waitMs: 3000,
      hide: true,
    });
    pidToClean = res2.pid;
    assert.equal(res2.ok, true);
    assert.equal(res2.portReady, true);
  } finally {
    killPidBestEffort(pidToClean);
    server.close();
  }
});

test('safeRun streams live output, enforces hard timeout with exitCode 124, and truncates overflow', async () => {
  const outLines = [];
  const psCallPrefix = process.platform === 'win32' ? '& ' : '';
  const okRes = await safeRun({
    command: `${psCallPrefix}"${process.execPath}" -e "for (let i=1;i<=30;i++) console.log('line-' + i)"`,
    timeoutSec: 15,
    maxLines: 10,
    onStdout: (s) => outLines.push(s),
    onStderr: () => {},
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.stdoutLines, 30);
  assert.equal(okRes.truncated, true);
  assert.match(outLines.join(''), /truncated 20 middle lines/);

  const timeoutRes = await safeRun({
    command: `${psCallPrefix}"${process.execPath}" -e "setTimeout(() => {}, 20000)"`,
    timeoutSec: 1,
    onStdout: () => {},
    onStderr: () => {},
  });
  assert.equal(timeoutRes.ok, false);
  assert.equal(timeoutRes.timedOut, true);
  assert.equal(timeoutRes.exitCode, 124);
});

test('task-doctor detects Empty log (0-byte) and canceled background tasks and classifies root cause', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-unstick-doc-'));
  try {
    const sessDir = path.join(tmpRoot, '11111111-2222-3333-4444-555555555555', '.system_generated');
    fs.mkdirSync(path.join(sessDir, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(sessDir, 'logs'), { recursive: true });

    fs.writeFileSync(path.join(sessDir, 'tasks', 'task-526.log'), '', 'utf8');
    fs.writeFileSync(
      path.join(sessDir, 'logs', 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 10,
          type: 'PLANNER_RESPONSE',
          tool_calls: [
            {
              name: 'run_command',
              args: { CommandLine: 'Start-Process "App.exe" -ArgumentList "--show"\nnode diag.mjs', IsDaemon: false },
            },
          ],
        }),
        JSON.stringify({
          step_index: 11,
          type: 'USER_INPUT',
          content: 'Task id "11111111-2222-3333-4444-555555555555/task-526" was canceled with result',
        }),
      ].join('\n'),
      'utf8',
    );

    const report = scanAllSessions({ brainDir: tmpRoot, days: 7 });
    assert.equal(report.totalFindings, 1);
    assert.equal(report.affectedSessions.length, 1);
    const finding = report.affectedSessions[0].findings[0];
    assert.equal(finding.emptyLog, true);
    assert.equal(finding.canceled, true);
    assert.equal(finding.cause, 'pipe_inheritance_start_process');
    assert.equal(classifyHangCause('Read-Host "pw"', false), 'interactive_stdin');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('installPlugin copies bundle, verifies status, and uninstalls cleanly into temp target', () => {
  const tmpTarget = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-unstick-inst-')), 'agy-unstick');
  try {
    const res = installPlugin({
      sourceDir: path.resolve(__dirname, '..'),
      targetDir: tmpTarget,
      mode: 'copy',
    });
    assert.equal(res.ok, true);
    const st1 = checkStatus(tmpTarget);
    assert.equal(st1.installed, true);
    assert.deepEqual(st1.missing, []);

    const rm = uninstallPlugin(tmpTarget);
    assert.equal(rm.existed, true);
    const st2 = checkStatus(tmpTarget);
    assert.equal(st2.installed, false);
  } finally {
    fs.rmSync(path.dirname(tmpTarget), { recursive: true, force: true });
  }
});
