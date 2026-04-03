@echo off
echo ============================================
echo   Cursor Mirror - Uninstall Service
echo ============================================
echo.

set NSSM=%~dp0nssm.exe
set SERVICE_NAME=CursorMirror

if not exist "%NSSM%" (
    echo [ERROR] nssm.exe not found!
    pause
    exit /b 1
)

"%NSSM%" status %SERVICE_NAME% >nul 2>&1
if not %ERRORLEVEL%==0 (
    echo Service "%SERVICE_NAME%" does not exist. Nothing to do.
    echo.
    pause
    exit /b 0
)

echo Current status:
"%NSSM%" status %SERVICE_NAME%
echo.

set /p confirm=Are you sure you want to uninstall? (y/N):
if /i not "%confirm%"=="y" (
    echo Cancelled.
    pause
    exit /b 0
)

echo.
echo [1/2] Stopping service...
"%NSSM%" stop %SERVICE_NAME%
timeout /t 3 >nul

echo [2/2] Removing service...
"%NSSM%" remove %SERVICE_NAME% confirm

echo.
echo Verifying...
"%NSSM%" status %SERVICE_NAME% >nul 2>&1
if %ERRORLEVEL%==0 (
    echo [WARNING] Service still exists. You may need to reboot.
) else (
    echo Service has been completely removed.
)
echo.
pause
