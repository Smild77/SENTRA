@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Windows console QuickEdit is ON by default. One stray click inside this
rem  window puts it in "select text" mode, and the next console.log FREEZES the
rem  whole node process: polling stops, every API call hangs, CPU drops to zero,
rem  and nothing says why. (If that ever happens: click the window, press Esc.)
rem
rem  Windows reads console options from HKCU\Console\<window title> at the moment
rem  the console is created, so the key has to exist BEFORE the window opens and
rem  the window has to be created with that exact title - hence the relaunch.
rem  This key only affects windows titled "SENTRA - Server", nothing else.
rem ---------------------------------------------------------------------------
if not "%SENTRA_CONSOLE%"=="1" (
  reg add "HKCU\Console\SENTRA - Server" /v QuickEdit /t REG_DWORD /d 0 /f >nul 2>&1
  set SENTRA_CONSOLE=1
  start "SENTRA - Server" /D "%~dp0" cmd /c ""%~f0""
  exit /b
)
title SENTRA - Server

rem Prefer a portable Node.js shipped next to the project. This is what lets
rem the app run on a PC where Node could not be installed: extract
rem node-vNN-win-x64.zip as <project>\node-portable and it is picked up here.
rem Falls back to a system-wide Node when that folder is absent.
set "PORTABLE_NODE=%~dp0..\node-portable"
if exist "%PORTABLE_NODE%\node.exe" set "PATH=%PORTABLE_NODE%;%PATH%"

echo ==========================================
echo   SENTRA - Start Server
echo ==========================================
echo.
echo  1. Check you are on the company network (wifi PAIPEI)
echo  2. Open browser at  http://localhost:3001/
echo.
echo  If the server ever stops responding and this window looks frozen,
echo  click on it and press Esc - that releases a stuck text selection.
echo.
echo ------------------------------------------
echo.

where node >nul 2>&1
if %errorlevel% neq 0 goto no_node
for /f "delims=" %%v in ('node -v') do echo Node %%v

if not exist "node_modules" goto do_install
goto check_env

:do_install
echo [SETUP] node_modules not found - installing, please wait...
call npm install
if %errorlevel% neq 0 goto install_failed
echo.

:check_env
if not exist ".env" goto no_env

echo Starting server...
echo The dashboard opens in your browser as soon as it is ready.
echo.
start "" /min "%~dp0open-ui.bat"
node sentra-server.js
echo.
echo ------------------------------------------
echo Server stopped.
goto end

:no_node
echo [ERROR] Node.js not found.
echo         Either install it from https://nodejs.org, or extract the
echo         portable node-vNN-win-x64.zip into this folder:
echo           %PORTABLE_NODE%
goto end

:install_failed
echo.
echo [ERROR] npm install failed.
goto end

:no_env
echo [ERROR] File .env not found (Oracle user/password).
echo         You must create  backend\.env  before the server can start.
goto end

:end
echo.
pause
