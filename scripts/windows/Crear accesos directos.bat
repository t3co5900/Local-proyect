@echo off
setlocal enableextensions
cd /d "%~dp0"

rem Crea el acceso directo "Mr.Cook POS" en el Escritorio (con el logo)
rem y, si queres, hace que arranque solo al prender la PC.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Mr.Cook POS.lnk'); $l.TargetPath='%~dp0Iniciar Mr.Cook.bat'; $l.WorkingDirectory='%~dp0'; $l.IconLocation='%~dp0mrcook.ico'; $l.WindowStyle=7; $l.Save()"
echo Listo: acceso directo "Mr.Cook POS" creado en el Escritorio.
echo.
choice /c SN /m "Queres que Mr.Cook arranque solo cuando se prende la PC"
if errorlevel 2 goto end
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut([Environment]::GetFolderPath('Startup')+'\Mr.Cook POS.lnk'); $l.TargetPath='%~dp0Iniciar Mr.Cook.bat'; $l.WorkingDirectory='%~dp0'; $l.IconLocation='%~dp0mrcook.ico'; $l.WindowStyle=7; $l.Save()"
echo Listo: Mr.Cook arrancara solo al iniciar sesion en Windows.
:end
echo.
pause
