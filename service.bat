@echo off
setlocal enabledelayedexpansion

set NSSM=%~dp0nssm.exe
set SERVICE_NAME=CursorMirror

if not exist "%NSSM%" (
    echo [ERROR] nssm.exe not found in project root
    pause
    exit /b 1
)

:menu
cls
echo.
echo  +==========================================+
echo  :       Cursor Mirror Service Manager      :
echo  +==========================================+
echo  :                                          :
echo  :   1.  Status                             :
echo  :   2.  Start                              :
echo  :   3.  Stop                               :
echo  :   4.  Restart                            :
echo  :   5.  View recent logs                   :
echo  :   6.  Open services.msc                  :
echo  :   7.  Edit config (NSSM GUI)             :
echo  :   0.  Exit                               :
echo  :                                          :
echo  +==========================================+
echo.
set /p choice=Select [0-7]:

if "%choice%"=="1" goto status
if "%choice%"=="2" goto start
if "%choice%"=="3" goto stop
if "%choice%"=="4" goto restart
if "%choice%"=="5" goto logs
if "%choice%"=="6" goto services
if "%choice%"=="7" goto edit
if "%choice%"=="0" exit /b 0
goto menu

:status
echo.
echo  --- Service Status ---
"%NSSM%" status %SERVICE_NAME%
echo.
pause
goto menu

:start
echo.
echo  Starting service...
"%NSSM%" start %SERVICE_NAME%
echo.
pause
goto menu

:stop
echo.
echo  Stopping service...
"%NSSM%" stop %SERVICE_NAME%
echo.
pause
goto menu

:restart
echo.
echo  Restarting service...
"%NSSM%" restart %SERVICE_NAME%
echo.
pause
goto menu

:logs
echo.
echo  --- Recent 30 lines ---
echo.
if exist "%~dp0logs\service.log" (
    powershell -Command "Get-Content '%~dp0logs\service.log' -Tail 30"
) else (
    echo  Log file does not exist
)
echo.
pause
goto menu

:services
start services.msc
goto menu

:edit
echo.
echo  Opening NSSM config editor...
"%NSSM%" edit %SERVICE_NAME%
echo.
pause
goto menu
