@echo off
setlocal enableextensions
cd /d "%~dp0"

rem Mr.Cook POS - lanzador. Doble clic: arranca el programa (oculto) y abre la ventana.
set "MRCOOK_DATA_DIR=%~dp0datos"
if not defined PORT set "PORT=3737"
set "URL=http://127.0.0.1:%PORT%"
if not exist "%MRCOOK_DATA_DIR%" mkdir "%MRCOOK_DATA_DIR%"

call :alive
if %errorlevel%==0 goto open

rem Servidor oculto; el registro queda en datos\servidor.log
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~dp0node\node.exe' -ArgumentList '--disable-warning=ExperimentalWarning','app\server\index.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%MRCOOK_DATA_DIR%\servidor.log' -RedirectStandardError '%MRCOOK_DATA_DIR%\servidor-errores.log'"

set /a tries=0
:wait
call :alive
if %errorlevel%==0 goto open
set /a tries+=1
if %tries% geq 40 goto fail
timeout /t 1 /nobreak >nul
goto wait

:open
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%EDGE%" goto openedge
if exist "%CHROME%" goto openchrome
start "" "%URL%"
exit /b 0

:openedge
start "" "%EDGE%" --app=%URL%
exit /b 0

:openchrome
start "" "%CHROME%" --app=%URL%
exit /b 0

:alive
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing '%URL%/api/bootstrap' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
exit /b %errorlevel%

:fail
echo.
echo No se pudo iniciar Mr.Cook POS.
echo Revisa el archivo datos\servidor-errores.log y avisale a quien te dio el programa.
echo.
pause
exit /b 1
