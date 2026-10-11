@echo off
REM Insurer claim-guide change monitor - Windows Task Scheduler wrapper (monthly).
REM Keep this file ASCII + CRLF: cmd.exe misparses LF line endings (broke Aug-Oct 2026 runs).
set PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
set PROJ=C:\projects\myguardian-v2
set LOG=%PROJ%\pipeline\monitor.log
cd /d "%PROJ%"
echo ==== %DATE% %TIME% start ==== >> "%LOG%"
"%PY%" pipeline\monitor_insurers.py >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%
echo ==== %DATE% %TIME% end rc=%RC% ==== >> "%LOG%"
exit /b %RC%
