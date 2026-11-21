'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getDefaultBrainDir() {
  if (process.env.AGY_BRAIN_DIR) {
    return path.resolve(process.env.AGY_BRAIN_DIR);
  }
  return path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
}

function classifyHangCause(commandLine, isDaemon) {
  const cmd = String(commandLine || '');
  if (!cmd.trim()) return 'unknown_command';
  if (/(^|[;|&(\s])(Start-Process|saps)\b/i.test(cmd) && !/-Wait\b/i.test(cmd)) {
    return 'pipe_inheritance_start_process';
  }
  if (/\bcmd(?:\.exe)?\s+\/[ck]\s+start\b/i.test(cmd)) {
    return 'pipe_inheritance_cmd_start';
  }
  if (/\b(Read-Host|pause)\b/i.test(cmd) || /\bcmd(?:\.exe)?\s+\/k\b/i.test(cmd)) {
    return 'interactive_stdin';
  }
  if (/\b(Start-Sleep|sleep)\b/i.test(cmd)) {
    return 'long_sleep';
  }
  if (!isDaemon && /\b(npm\s+run\s+dev|pnpm\s+dev|yarn\s+dev|next\s+dev|nodemon|uvicorn|tail\s+-f|-Wait)\b/i.test(cmd)) {
    return 'unmarked_daemon';
  }
  return 'unflushed_or_timeout';
}

function parseTranscript(transcriptPath) {
  const commands = [];
  const taskToCommand = new Map();
  const canceled = new Map();
  if (!fs.existsSync(transcriptPath)) {
    return { commands, taskToCommand, canceled };
  }
  const raw = fs.readFileSync(transcriptPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }

    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    for (const tc of calls) {
      if (tc && tc.name === 'run_command' && tc.args) {
        commands.push({
          stepIndex: step.step_index ?? null,
          createdAt: step.created_at || null,
          commandLine: String(tc.args.CommandLine || ''),
          isDaemon: Boolean(tc.args.IsDaemon),
          waitMs: tc.args.WaitMsBeforeAsync ?? null,
        });
      }
    }

    const content = typeof step.content === 'string' ? step.content : '';
    const bgMatch = content.match(/with task id:\s*[^\s"'\/]+\/(task-[0-9A-Za-z_-]+)/i);
    if (bgMatch) {
      const tid = bgMatch[1];
      const descMatch = content.match(/Task Description:\s*([\s\S]+?)(?:\r?\n(?:Task logs|Log output|YOU MUST|Log:)|$)/i);
      const descText = descMatch ? descMatch[1].trim() : '';
      const descNorm = descText.replace(/\s+/g, ' ').slice(0, 48);
      const matchedCmd = descNorm
        ? commands.slice().reverse().find((c) => c.commandLine.replace(/\s+/g, ' ').trim().startsWith(descNorm))
        : null;
      const fallbackRecent = matchedCmd || (commands.length > 0 ? commands[commands.length - 1] : null);
      taskToCommand.set(tid, {
        commandLine: matchedCmd ? matchedCmd.commandLine : (descText || (fallbackRecent ? fallbackRecent.commandLine : '')),
        isDaemon: matchedCmd ? matchedCmd.isDaemon : false,
      });
    }

    const cancelRegex = /Task id\s+"[^"]*\/(task-[^"]+)"\s+was canceled/gi;
    let match;
    while ((match = cancelRegex.exec(content)) !== null) {
      canceled.set(match[1], true);
    }
  }
  return { commands, taskToCommand, canceled };
}

function scanSession(sessionDir) {
  const sessionId = path.basename(sessionDir);
  const sysDir = path.join(sessionDir, '.system_generated');
  const tasksDir = path.join(sysDir, 'tasks');
  const logsDir = path.join(sysDir, 'logs');
  const transcriptPath = fs.existsSync(path.join(logsDir, 'transcript_full.jsonl'))
    ? path.join(logsDir, 'transcript_full.jsonl')
    : path.join(logsDir, 'transcript.jsonl');

  if (!fs.existsSync(tasksDir)) {
    return null;
  }

  const taskFiles = fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.log'));

  if (taskFiles.length === 0) {
    return null;
  }

  const { commands, taskToCommand, canceled: canceledMap } = parseTranscript(transcriptPath);
  const findings = [];

  for (const tf of taskFiles) {
    const taskId = tf.name.replace(/\.log$/, '');
    const full = path.join(tasksDir, tf.name);
    const stat = fs.statSync(full);
    const isEmptyLog = stat.size === 0;
    const isCanceled = canceledMap.has(taskId);
    if (!isEmptyLog && !isCanceled) continue;

    // Prefer exact task-id correlation, falling back to last known run_command.
    const exactCmd = taskToCommand.get(taskId) || null;
    const fallbackCmd = commands.length > 0 ? commands[commands.length - 1] : null;
    const likelyCmd = exactCmd || fallbackCmd;

    findings.push({
      sessionId,
      taskId,
      logPath: full,
      sizeBytes: stat.size,
      emptyLog: isEmptyLog,
      canceled: isCanceled,
      mtimeMs: stat.mtimeMs,
      mtimeIso: new Date(stat.mtimeMs).toISOString(),
      cause: likelyCmd ? classifyHangCause(likelyCmd.commandLine, likelyCmd.isDaemon) : 'unknown_command',
      sampleCommand: likelyCmd ? likelyCmd.commandLine.slice(0, 200) : '',
    });
  }

  if (findings.length === 0) return null;
  return {
    sessionId,
    findings,
    totalTasks: taskFiles.length,
  };
}

function scanAllSessions(options = {}) {
  const brainDir = options.brainDir ? path.resolve(options.brainDir) : getDefaultBrainDir();
  const days = Number(options.days) > 0 ? Number(options.days) : 7;
  const cutoffMs = Date.now() - days * 86_400_000;
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 50;

  if (!fs.existsSync(brainDir)) {
    return { brainDir, sessionsScanned: 0, affectedSessions: [], totalFindings: 0, causeCounts: {} };
  }

  const entries = fs.readdirSync(brainDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  let sessionsScanned = 0;
  const affectedSessions = [];
  const causeCounts = {};
  let totalFindings = 0;

  for (const entry of entries) {
    const dir = path.join(brainDir, entry.name);
    const stat = fs.statSync(dir);
    if (stat.mtimeMs < cutoffMs) continue;
    sessionsScanned += 1;
    const res = scanSession(dir);
    if (!res) continue;
    const recentFindings = res.findings.filter((f) => f.mtimeMs >= cutoffMs);
    if (recentFindings.length === 0) continue;
    for (const f of recentFindings) {
      totalFindings += 1;
      causeCounts[f.cause] = (causeCounts[f.cause] || 0) + 1;
    }
    affectedSessions.push({ ...res, findings: recentFindings });
    if (affectedSessions.length >= limit) break;
  }

  affectedSessions.sort((a, b) => {
    const ma = Math.max(...a.findings.map((f) => f.mtimeMs));
    const mb = Math.max(...b.findings.map((f) => f.mtimeMs));
    return mb - ma;
  });

  return {
    brainDir,
    days,
    sessionsScanned,
    affectedSessions,
    totalFindings,
    causeCounts,
  };
}

module.exports = {
  getDefaultBrainDir,
  classifyHangCause,
  scanSession,
  scanAllSessions,
};
