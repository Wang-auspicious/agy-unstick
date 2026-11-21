# Antigravity 防卡死与后台任务规范 (agy-unstick)

## 1. 严禁在 `run_command` 中用 `Start-Process` / `cmd start` 拉起脱离终端的子进程
- 在 Windows Antigravity 中，`run_command` 通过 stdout/stderr 管道判断命令结束。使用 `Start-Process` 启动 Electron、浏览器或本地服务后即使主 PowerShell 退出，子进程仍继承管道句柄，导致后台任务永远等不到 EOF、日志停在 `Empty log` 且不发完成通知。
- 需要分离启动任何桌面端、浏览器或测试服务时，优先使用纯 Node `safe-exec`（`safe-launch`）以 `{ detached: true, stdio: 'ignore' }` + `.unref()` 彻底切断句柄继承，并在必要时使用 `--wait-port` 等待监听就绪。

## 2. 长耗时或容易挂起的测试/脚本使用超时护栏
- 对可能死锁或等待端口的命令行脚本，优先用 `safe-run --timeout <秒> --max-lines 200 -- <command>` 替代裸跑，确保超时时整棵进程树被清理并实时 flush 首尾日志。
- 若发现此前出现过 `Empty log` 或后台任务被迫取消，调用 `task-doctor` 快速溯源具体的阻塞步骤和命令。
