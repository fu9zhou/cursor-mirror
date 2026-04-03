@echo off
echo ============================================
echo   Cursor Mirror - Install Service
echo ============================================
echo.

set NSSM=%~dp0nssm.exe
set SERVICE_NAME=CursorMirror

if not exist "%NSSM%" (
    echo [ERROR] nssm.exe not found!
    echo Please download from https://nssm.cc/download
    echo and put win64\nssm.exe in this folder.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -e "console.log(process.execPath)" 2^>nul') do set NODE_PATH=%%i
if "%NODE_PATH%"=="" (
    echo [ERROR] node.exe not found in PATH!
    pause
    exit /b 1
)

set ENTRY=%~dp0src\index.js
set APPDIR=%~dp0.
set LOG_DIR=%~dp0logs
set LOG_OUT=%~dp0logs\service.log
set LOG_ERR=%~dp0logs\service-error.log

echo Node:    %NODE_PATH%
echo Entry:   %ENTRY%
echo AppDir:  %APPDIR%
echo Service: %SERVICE_NAME%
echo.

"%NSSM%" status %SERVICE_NAME% >nul 2>&1
if %ERRORLEVEL%==0 (
    echo Service already exists. Removing old one first...
    "%NSSM%" stop %SERVICE_NAME% >nul 2>&1
    "%NSSM%" remove %SERVICE_NAME% confirm >nul 2>&1
    timeout /t 2 >nul
)

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo [1/6] Registering service...
"%NSSM%" install %SERVICE_NAME% "%NODE_PATH%"

echo [2/6] Configuring paths...
"%NSSM%" set %SERVICE_NAME% AppParameters "%ENTRY%"
"%NSSM%" set %SERVICE_NAME% AppDirectory "%APPDIR%"

echo [3/6] Setting display name...
"%NSSM%" set %SERVICE_NAME% DisplayName "Cursor Mirror"
"%NSSM%" set %SERVICE_NAME% Description "Cursor IDE Mirror"

echo [4/6] Configuring logs...
"%NSSM%" set %SERVICE_NAME% AppStdout "%LOG_OUT%"
"%NSSM%" set %SERVICE_NAME% AppStderr "%LOG_ERR%"
"%NSSM%" set %SERVICE_NAME% AppRotateFiles 1
"%NSSM%" set %SERVICE_NAME% AppRotateBytes 5242880

echo [5/6] Setting auto-restart on crash (5s delay)...
"%NSSM%" set %SERVICE_NAME% AppRestartDelay 5000

echo [6/6] Starting service...
"%NSSM%" start %SERVICE_NAME%

timeout /t 3 >nul
echo.
echo ============================================
"%NSSM%" status %SERVICE_NAME%
echo ============================================
echo.
echo Done! Open http://localhost:6700 to verify.
echo.
pause
