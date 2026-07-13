' Ziggy Silent Startup Launcher
' Launches Ollama, ComfyUI, and your local executor invisibly on boot.
' Each launch is individually error-guarded, so if one fails, it can't
' silently stop the others from starting.
On Error Resume Next
Set WshShell = CreateObject("WScript.Shell")

' Set GPU & Concurrency variables
WshShell.Environment("PROCESS")("CUDA_VISIBLE_DEVICES") = "0"
WshShell.Environment("PROCESS")("OLLAMA_NUM_PARALLEL") = "4"
WshShell.Environment("PROCESS")("OLLAMA_MAX_LOADED_MODELS") = "4"

' Launch Ollama serve silently
Err.Clear
WshShell.Run """C:\Users\YOUR_USERNAME\AppData\Local\Programs\Ollama\ollama.exe"" serve", 0, False
Err.Clear

' Wait 3 seconds for Ollama to be ready
WScript.Sleep 3000

' Launch ComfyUI silently. Uses "cmd /c cd /d <path> && ..." to set the
' working directory reliably for THIS specific launch, rather than relying
' on WshShell.CurrentDirectory (which is what failed silently before).
Err.Clear
WshShell.Run "cmd /c cd /d C:\AI\ComfyUI && .\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --fast fp16_accumulation", 0, False
Err.Clear

' Wait for Ollama + ComfyUI to both settle before starting the executor
WScript.Sleep 3000

' Launch Telegram Commander bot agent silently
Err.Clear
WshShell.Run "node ""C:\Users\YOUR_USERNAME\Documents\Antigravity\Ziggy\local_executor.js""", 0, False
Err.Clear
