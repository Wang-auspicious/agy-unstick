#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function allow() {
  process.stdout.write('{"decision":"allow"}\n');
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason }) + '\n');
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

function resolvePluginRoot() {
  return path.resolve(__dirname, '..');
}

function splitStatements(commandLine) {
  return String(commandLine || '')
    .split(/\r?\n|;|&&|\|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isSearchOnlyCommand(stmt) {
  return /^(rg|grep|git\s+(?:grep|log|diff|commit|status)|Select-String|findstr|echo|Write-Host)\b/i.test(stmt);
}

function extractStartProcessSuggestion(stmt, safeLaunchCli) {
  const fpMatch = stmt.match(/-FilePath\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  const exe = fpMatch ? (fpMatch[1] || fpMatch[2] || fpMatch[3]) : '<target-executable>';
  const argMatch = stmt.match(/-ArgumentList\s+([^\r\n]+)$/i);
  let argsPreview = '';
  if (argMatch) {
    argsPreview = ' ' + argMatch[1]
      .replace(/['",]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return `node "${safeLaunchCli}" -- "${exe}"${argsPreview}`;
}

function checkStartProcessHang(statements, safeLaunchCli) {
  for (const stmt of statements) {
    if (isSearchOnlyCommand(stmt)) continue;
    const stripped = stmt.replace(/^\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '');
    const isDirectStartProcess = /^(?:Start-Process|saps)\b/i.test(stripped);
    const isWrappedStartProcess =
      /^(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\b(?:Start-Process|saps)\b/i.test(stripped);
    if ((isDirectStartProcess || isWrappedStartProcess) && !/\s-Wait\b/i.test(stripped)) {
      const replacement = extractStartProcessSuggestion(stripped, safeLaunchCli);
      return (
        `🛑 [agy-unstick 防卡死护栏] 检测到未加 -Wait 的 Start-Process：在 Windows Antigravity run_command 中，子 GUI/后台进程会继承父 Shell 的 stdout/stderr 管道句柄，导致命令结束后任务管理器永远等不到 EOF、日志卡死在 "Empty log" 并且永远不返回！\n` +
        `请改用零管道继承的 safe-launch 分离启动器：\n\n` +
        `  ${replacement}\n\n` +
        `（如需先杀旧进程或等端口就绪，可加 --kill-name "<进程名>" 或 --wait-port <端口>；如需确认只是短时同步启动并阻塞等待退出，请显式传 Start-Process -Wait。）`
      );
    }
    if (/^(?:cmd(?:\.exe)?)\s+\/[cCk]\s+start\b/i.test(stmt)) {
      return (
        `🛑 [agy-unstick 防卡死护栏] 检测到 \`cmd /c start\`：容易与当前命令窗口共享管道或控制台会话。\n` +
        `请改用彻底脱钩的 safe-launch 启动：\n\n` +
        `  node "${safeLaunchCli}" -- <executable> [args...]`
      );
    }
    if (/(?:^|\s)nohup\s+/i.test(stmt) && !/>\s*\/dev\/null\s+2>&1|<\s*\/dev\/null/i.test(stmt)) {
      return (
        `🛑 [agy-unstick 防卡死护栏] 检测到未重定向 stdin/stdout/stderr 的 \`nohup\`，子进程仍继承当前终端管道导致后台任务无法收口。\n` +
        `请改用 safe-launch 或补充 \`</dev/null >/tmp/out.log 2>&1 &\`：\n\n` +
        `  node "${safeLaunchCli}" -- <command> [args...]`
      );
    }
  }
  return null;
}

function checkInteractiveStdin(statements) {
  for (const stmt of statements) {
    if (isSearchOnlyCommand(stmt)) continue;
    const stripped = stmt.replace(/^\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '');
    if (/^Read-Host\b/i.test(stripped)) {
      return (
        `🛑 [agy-unstick 防卡死护栏] 检测到阻塞等待标准输入的 \`Read-Host\`。\n` +
        `无交互后台代理调用时 \`Read-Host\` 会永久挂死；如需向用户提问，请改用内置 AskUser/ask_question 工具，或在参数中直接传值。`
      );
    }
    if (/^@?pause$/i.test(stmt)) {
      return (
        `🛑 [agy-unstick 防卡死护栏] 检测到阻塞按键的 \`pause\` 命令，会导致命令窗口永远等待键盘输入。请移除 \`pause\`。`
      );
    }
    if (/^cmd(?:\.exe)?\s+\/k\b/i.test(stmt) || /^(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s-NoExit\b/i.test(stmt)) {
      return (
        `🛑 [agy-unstick 防卡死护栏] 检测到保持交互外壳不退出的 \`cmd /k\` 或 \`-NoExit\` 参数，任务将永远不会退出。\n` +
        `请改用 \`cmd /c\` / 去掉 \`-NoExit\`，或如果是常驻进程请使用 IsDaemon: true / safe-launch。`
      );
    }
  }
  return null;
}

function checkLongSleep(statements) {
  for (const stmt of statements) {
    if (isSearchOnlyCommand(stmt)) continue;
    const psSleep = stmt.match(/^Start-Sleep\b([^\r\n]*)$/i);
    if (psSleep) {
      const args = psSleep[1] || '';
      const msMatch = args.match(/-Milli(?:seconds)?\s+(\d+)/i);
      const secMatch = args.match(/(?:-Seconds\s+)?(?:^|\s)(\d+)(?:\s|$)/i);
      const ms = msMatch ? Number(msMatch[1]) : secMatch ? Number(secMatch[1]) * 1000 : 0;
      if (ms >= 15000) {
        return (
          `🛑 [agy-unstick 防卡死护栏] 检测到超过 15 秒的阻塞休眠（Start-Sleep ${(ms / 1000).toFixed(0)}s）。\n` +
          `长时间 Shell sleep 会占死终端配额且不可响应消息；请改用内置 \`schedule\` 定时器工具或缩短到 <15s 的定向就绪探测。`
        );
      }
    }
    const unixSleep = stmt.match(/^sleep\s+(\d+)\s*([smh]?)$/i);
    if (unixSleep) {
      const n = Number(unixSleep[1]);
      const unit = (unixSleep[2] || 's').toLowerCase();
      const secs = unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
      if (secs >= 15) {
        return (
          `🛑 [agy-unstick 防卡死护栏] 检测到超过 15 秒的 \`sleep ${n}${unit}\`，请改用 \`schedule\` 定时器工具，禁止用长休眠占位。`
        );
      }
    }
  }
  return null;
}

function checkUnmarkedDaemon(statements, isDaemon, safeLaunchCli) {
  if (isDaemon) return null;
  for (const stmt of statements) {
    if (isSearchOnlyCommand(stmt)) continue;
    const matched =
      /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start:dev|watch)\b/i.test(stmt) ||
      /^(?:npx\s+)?(?:next\s+dev|nodemon|uvicorn|flask\s+run)\b/i.test(stmt) ||
      /^python(?:3)?\s+-m\s+http\.server\b/i.test(stmt) ||
      (/^(?:npx\s+)?tsc\b/i.test(stmt) && /\s(?:--watch|-w)\b/.test(stmt)) ||
      /^tail\s+-[a-zA-Z]*f\b/.test(stmt) ||
      (/^Get-Content\b/i.test(stmt) && /\s-Wait\b/i.test(stmt));

    if (matched) {
      return (
        `🛑 [agy-unstick 防卡死护栏] 检测到前景常驻服务 / Watcher 命令未设置 \`IsDaemon: true\`：\n` +
        `  ${stmt}\n\n` +
        `这会导致命令卡住直至手动取消或 Empty log。\n` +
        `请二选一：\n` +
        `1. 在本工具调用中设置 \`IsDaemon: true\`；或\n` +
        `2. 用 \`node "${safeLaunchCli}" --wait-port <端口> -- ...\` 彻底分离后台拉起。`
      );
    }
  }
  return null;
}

function evaluateCommand(payload) {
  if (process.env.AGY_UNSTICK_DISABLE === '1') {
    return { decision: 'allow' };
  }
  const toolCall = payload && payload.toolCall ? payload.toolCall : payload;
  const toolName = toolCall && (toolCall.name || toolCall.tool_name);
  if (toolName !== 'run_command') {
    return { decision: 'allow' };
  }

  const args = (toolCall && (toolCall.args || toolCall.tool_input)) || {};
  const commandLine = String(args.CommandLine ?? args.commandLine ?? args.command ?? '');
  if (!commandLine.trim()) {
    return { decision: 'allow' };
  }

  // Already routed through safe-launch or safe-run -> allow cleanly.
  if (/(?:safe-launch|safe-run)[\\/]cli\.js\b/i.test(commandLine)) {
    return { decision: 'allow' };
  }

  const isDaemon = Boolean(args.IsDaemon ?? args.isDaemon);
  const pluginRoot = resolvePluginRoot();
  const safeLaunchCli = path.join(pluginRoot, 'tools', 'safe-launch', 'cli.js');
  const statements = splitStatements(commandLine);

  const reason =
    checkStartProcessHang(statements, safeLaunchCli) ||
    checkInteractiveStdin(statements) ||
    checkLongSleep(statements) ||
    checkUnmarkedDaemon(statements, isDaemon, safeLaunchCli);

  if (reason) {
    return { decision: 'deny', reason };
  }
  return { decision: 'allow' };
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw || !raw.trim()) {
      return allow();
    }
    const payload = JSON.parse(raw);
    const verdict = evaluateCommand(payload);
    if (verdict.decision === 'deny') {
      return deny(verdict.reason);
    }
    return allow();
  } catch {
    // Always fail open so an unexpected parser issue never blocks normal tool flow.
    return allow();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateCommand,
  splitStatements,
};
