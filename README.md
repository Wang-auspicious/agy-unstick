# AGY-Unstick

> **Eliminate Antigravity `Empty log` background-task deadlocks, Windows `Start-Process` pipe-inheritance hangs, interactive stdin stalls, and runaway watchers — using pure Node.js (`0` external dependencies).**

Native Antigravity plugin (`plugin.json` + `hooks.json` + `rules` + `skills` + CLI tools) designed cleanly along the plugin conventions of `agy-tokless`.

---

## 10-Second Install Inside Antigravity

Paste this prompt into any Antigravity chat window:

```text
Please clone https://github.com/Wang-auspicious/agy-unstick locally and run `node install.js --copy` to globally install and enable the `agy-unstick` anti-hang plugin, then run its `task-doctor` CLI to scan my recent sessions for Empty log background task hangs.
```

---

## Why Does Antigravity Hang on `"Empty log"` in Windows PowerShell?

On Windows, Antigravity's `run_command` tool monitors command completion and streams task logs via inherited `stdout`/`stderr` pipe handles of the shell child process.

When a command runs `Start-Process app.exe` (for example, launching an Electron desktop build or dev server) followed by another short command:

```text
PowerShell parent shell  ──▶ stdout/stderr pipe ──▶ Antigravity task runner
   ├─ Start-Process child GUI app  (INHERITS the same pipe handles!)
   └─ node script.mjs              (finishes quickly, closes its handles)
```

Even after both PowerShell and `script.mjs` finish, the long-lived GUI/background child process keeps the pipe handles open. Antigravity waits forever for EOF, buffered output stays stuck at **`Empty log`**, no completion notification is sent, and the conversation stalls indefinitely.

---

## Components (Pure Node.js Standard Library · Zero Native Dependencies)

### 1. `PreToolUse` Anti-Hang Guardrail (`hooks.json` + `scripts/cmd-guard-hook.js`)
Automatically inspects `run_command` payloads before execution (always failing open on parse errors so normal work is never blocked):

| Anti-Pattern | What Happens | Suggested Safe Replacement |
| :--- | :--- | :--- |
| `Start-Process` / `saps` without `-Wait`, `cmd /c start`, unredirected `nohup` | **Blocked (`deny`)** before pipe-inheritance deadlock occurs | Ready-to-run `safe-launch` command with zero handle inheritance |
| `Read-Host`, `pause`, `cmd /k`, `powershell -NoExit` | **Blocked (`deny`)** | Built-in `AskUser` or non-interactive arguments |
| `Start-Sleep >= 15s` / `sleep >= 15s` | **Blocked (`deny`)** | Built-in `schedule` tool or short port readiness check |
| `npm run dev`, `vite`, `tsc --watch`, `nodemon`, `tail -f`, `uvicorn` without `IsDaemon: true` | **Blocked (`deny`)** | Add `IsDaemon: true` or launch via `safe-launch --wait-port` |

Allows `Start-Process ... -Wait`, normal builds/tests (`npm test`, `tsc --noEmit`, `git status`), searches (`rg`, `grep`), `IsDaemon: true`, and commands already using `safe-launch` / `safe-run`. Set `AGY_UNSTICK_DISABLE=1` to bypass temporarily if ever needed.

### 2. `safe-launch` — Completely Detached Launcher (`tools/safe-launch/cli.js`)
Spawns processes with `{ detached: true, stdio: 'ignore' }` and calls `child.unref()`, preventing any handle inheritance:

```bash
# Cleanly restart and launch a GUI binary detached (exits in milliseconds)
node "./tools/safe-launch/cli.js" --kill-name "Magic Pointer" -- "C:\Users\...\Magic Pointer.exe" --show --remote-debugging-port=9233

# Launch a dev/CDP target and wait until its TCP port accepts connections
node "./tools/safe-launch/cli.js" --wait-port 9233 --wait-ms 15000 -- "<exe-or-cmd>"
```

### 3. `safe-run` — Hard-Timeout Streaming Runner (`tools/safe-run/cli.js`)
Runs commands with `stdin: 'ignore'` (immediate EOF on accidental prompts), live line-flushed output (never stuck in stdio buffers), hard `--timeout <sec>` full process-tree cleanup (`taskkill /F /T /PID` on Windows / PGID kill on POSIX), and automatic middle-truncation over `--max-lines`:

```bash
node "./tools/safe-run/cli.js" --timeout 60 --max-lines 200 -- "node ./verify.mjs"
```

### 4. `task-doctor` — 0-Token Background Task Forensics (`tools/task-doctor/cli.js`)
Scans `~/.gemini/antigravity/brain/*/.system_generated/tasks/*.log` and `transcript*.jsonl` locally (0 model tokens) to detect `Empty log` (`0`-byte) task logs and canceled background tasks and match them to their root-cause command:

```bash
node "./tools/task-doctor/cli.js" scan --days 7
node "./tools/task-doctor/cli.js" session <session-id-prefix>
node "./tools/task-doctor/cli.js" stats --days 30
```

---

## Local Verification

```bash
npm test
node ./install.js --copy
node ./install.js --status
```

---

## Acknowledgments

- Plugin bundle conventions (`plugin.json`, `hooks.json`, `skills/`, `rules/AGENTS.md`, `install.js --copy`) and local session-log forensic design take inspiration from **[daoif/agy-tokless](https://github.com/daoif/agy-tokless)**.

## License

[MIT](./LICENSE)
