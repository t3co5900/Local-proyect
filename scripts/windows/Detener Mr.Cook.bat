@echo off
setlocal enableextensions
cd /d "%~dp0"

rem Detiene el programa. Los datos quedan guardados.
if not exist "datos\mrcook.pid" goto notrunning
set /p PID=<"datos\mrcook.pid"
taskkill /PID %PID% /T /F >nul 2>&1
del "datos\mrcook.pid" >nul 2>&1
echo Mr.Cook POS detenido.
timeout /t 3 >nul
exit /b 0

:notrunning
echo Mr.Cook POS no esta en ejecucion.
timeout /t 3 >nul
exit /b 0
