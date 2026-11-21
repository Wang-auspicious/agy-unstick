---
name: safe-exec
description: >-
  Safely launch detached GUI apps or background services on Windows/POSIX without
  stdout/stderr pipe inheritance ("Empty log" background task hangs), or run
  risky commands with a hard timeout, live line-flushed streaming, and full
  process-tree cleanup via agy-unstick's safe-launch and safe-run CLIs.
---

# Safe Detached Launch & Timeout Runner (`safe-exec`)

Use the bundled zero-dependency Node CLIs inside `${PLUGIN_ROOT}` whenever a command might leave child pipe handles open or hang indefinitely.

## 1. Detached GUI / Server Launcher (`safe-launch`)

Never mix `Start-Process` + follow-up commands in a Windows PowerShell `run_command` call. Use `safe-launch` instead:

```bash
# Launch a Windows GUI app detached, killing any old instance first
node "${PLUGIN_ROOT}/tools/safe-launch/cli.js" --kill-name "Magic Pointer" -- "C:\Users\...\Magic Pointer.exe" --show --remote-debugging-port=9233

# Launch an app and wait until its debugging / HTTP port is ready (fails fast after --wait-ms)
node "${PLUGIN_ROOT}/tools/safe-launch/cli.js" --wait-port 9233 --wait-ms 15000 -- "<path-to-exe>" --show --remote-debugging-port=9233
```

Because `safe-launch` spawns with `{ detached: true, stdio: 'ignore' }` and calls `child.unref()`, zero stdout/stderr pipe handles are inherited by the child process and the `run_command` step exits cleanly in milliseconds.

## 2. Hard-Timeout Streaming Runner (`safe-run`)

Use `safe-run` for commands that might stall on prompts, sockets, or runaway child trees, or flood stdout:

```bash
node "${PLUGIN_ROOT}/tools/safe-run/cli.js" --timeout 60 --max-lines 200 -- "node ./scripts/cdp_check.mjs"
```

- Redirects `stdin` from `ignore` (so prompts immediately get EOF rather than deadlocking).
- Flushes stdout/stderr line-by-line immediately (never stalls at `Empty log`).
- Kills the entire process tree (`taskkill /F /T /PID` on Windows, negative-PGID `SIGKILL` on POSIX) when `--timeout` triggers.
