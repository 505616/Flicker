@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo   闪传 Flicker
echo   一次性文件传输 ^| 接收端零安装 ^| 用完即销毁
echo.

rem ── 找 Node ────────────────────────────────────────────────
rem 先查 PATH；找不到再试几个常见安装位置（有些安装方式不写 PATH）
set "NODE="

for /f "delims=" %%p in ('where node 2^>nul') do (
  if not defined NODE set "NODE=%%p"
)

if not defined NODE (
  for %%d in (
    "%ProgramFiles%\nodejs\node.exe"
    "%ProgramFiles(x86)%\nodejs\node.exe"
    "%LOCALAPPDATA%\Programs\nodejs\node.exe"
    "%APPDATA%\npm\node.exe"
  ) do (
    if not defined NODE if exist "%%~d" set "NODE=%%~d"
  )
)

if not defined NODE goto nonode

rem ── 查版本 ──────────────────────────────────────────────────
rem ⚠️ 这一步踩了四个坑，缺一个就失败（表现为 %MAJOR% 为空 → 被误判成
rem    "Node 太旧" → 错误地打开 Node 下载页，而用户其实装得好好的）：
rem
rem   ① 文件必须是 **CRLF 行尾**。LF-only 时 cmd 对 for /f 的解析会失效。
rem   ② 循环变量必须写 %%v（两个百分号）。写 %v 会被当参数展开，拿到空值。
rem   ③ **for /f 解析不了"带引号且含空格"的可执行路径**。实测：
rem        in ('"C:\Program Files\nodejs\node.exe" -p ...')  → 空
rem        in ('node -p ...')                                → 24  ✓
rem      加 usebackq 也不行。所以这里用**裸名字 node** 执行。
rem   ④ 别用 `node --version`：输出带 v 前缀，还得再剥一层。
rem      用 `node -p "process.versions.node"` 直接拿纯数字。
set "MAJOR="
for /f "delims=." %%v in ('node -p "process.versions.node" 2^>nul') do (
  if not defined MAJOR set "MAJOR=%%v"
)

rem 走到这里分三种情况：
rem   · MAJOR 有值            → 正常，下面判版本
rem   · MAJOR 空但 NODE 有值  → PATH 里没有 node，但已知目录里找到了一个。
rem                             没法用裸名字执行（见坑③），所以不在这里判版本，
rem                             直接启动，让 Node 自己报错更准确。
rem   · 两个都空              → 真的没装
if not defined MAJOR (
  if defined NODE (
    echo   注意：Node 不在 PATH 里，本次直接用找到的路径启动：
    echo         %NODE%
    echo.
    goto launch
  )
  goto nonode
)

set /a MAJOR_NUM=%MAJOR% 2>nul
if not defined MAJOR_NUM goto nonode
if %MAJOR_NUM% LSS 24 goto oldnode

:launch

rem ── 启动 ────────────────────────────────────────────────────
rem --check：只做自检，不启动程序。
rem 用途：装了 Node 却"双击没反应 / 跳下载页"时，跑一下这个立刻看出是哪一步不对。
if /i "%~1"=="--check" (
  echo   自检结果：
  echo     找到的 Node    = %NODE%
  echo     主版本号       = v%MAJOR%  ^(需要 v24 或更高^)
  echo     当前目录       = %CD%
  if exist "bin\flicker.js" (echo     入口文件       = 存在) else (echo     入口文件       = 不存在  ← 问题在这里^!)
  echo.
  "%NODE%" --version
  exit /b 0
)

rem 不带参数 = 打开图形界面（与文档一致）。
"%NODE%" "bin\flicker.js" %*
set CODE=%ERRORLEVEL%
if %CODE% NEQ 0 (
  echo.
  echo   程序以退出码 %CODE% 结束。
  rem ⚠️ 退出码 1 且**没有任何错误文字**时，绝大多数是自己关掉了窗口或按了 Ctrl+C ——
  rem    Windows 把"被强制结束的进程"一律报成 1，且不带信号标记。
  rem    不加这句说明的话，用户会以为程序崩了（实测就有人这么问过）。
  echo   ^(如果这是你自己关掉窗口或按了 Ctrl+C，那属于正常结束，没有任何东西残留^)
)
echo.
pause
exit /b %CODE%

:nonode
echo   没有找到 Node.js（或者找到的版本读不出来）。
echo.
echo   闪传需要一个 Node.js 运行时（v24 或更高）。请到下面的地址下载安装：
echo.
echo       https://nodejs.org/     ^(选 LTS 版本^)
echo.
echo   安装完成后，重新双击本文件即可。
echo.
echo   如果你确定已经装过 Node，可以在命令行里试试：
echo       where node
echo   然后把它的输出路径告诉程序的作者。
echo.
start "" "https://nodejs.org/"
pause
exit /b 1

:oldnode
echo   你的 Node.js 版本太旧：v%MAJOR%（需要 v24 或更高）。
echo.
echo   这个版本跑不了：闪传用到了 node:sea、crypto.subtle 等较新的内置能力。
echo   请到 https://nodejs.org/ 下载新版本覆盖安装。
echo.
start "" "https://nodejs.org/"
pause
exit /b 1
