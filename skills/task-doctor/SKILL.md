---
name: task-doctor
description: >-
  0-token forensic diagnostic scanner for Google Antigravity background tasks.
  Detects Empty log (0-byte) task logs, canceled background tasks, and correlates
  each hang back to the offending run_command in transcript.jsonl.
---

# Background Task & Empty-Log Forensics (`task-doctor`)

Run read-only offline forensics on Antigravity session task logs (`~/.gemini/antigravity/brain/*/.system_generated/tasks/*.log`) without consuming model tokens:

```bash
# Scan the last 7 days across all local Antigravity sessions
node "${PLUGIN_ROOT}/tools/task-doctor/cli.js" scan --days 7

# Inspect a specific session by ID or prefix
node "${PLUGIN_ROOT}/tools/task-doctor/cli.js" session <session-id-prefix>

# Output structured JSON or aggregate 30-day statistics
node "${PLUGIN_ROOT}/tools/task-doctor/cli.js" stats --days 30
node "${PLUGIN_ROOT}/tools/task-doctor/cli.js" scan --days 7 --json
```

Classifies incidents into `pipe_inheritance_start_process`, `pipe_inheritance_cmd_start`, `interactive_stdin`, `long_sleep`, `unmarked_daemon`, and `unflushed_or_timeout`.
