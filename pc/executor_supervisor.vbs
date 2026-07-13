' Ziggy Executor Supervisor Launcher
' Run by Windows Task Scheduler every 5 minutes, forever, independent of
' whether local_executor.js (or anything else on this PC) is currently
' alive. Relies entirely on local_executor.js's own existing single-
' instance lock (port 49352) to make repeat launches a safe no-op if
' it's already running — this script never needs to check anything
' itself, it just tries, unconditionally, every time it's run.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d C:\Users\YOUR_USERNAME\Documents\Antigravity\Ziggy && node local_executor.js", 0, False
