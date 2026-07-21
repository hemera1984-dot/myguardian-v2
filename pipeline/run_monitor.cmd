@echo off
REM 보험사 청구 안내 변경 감시 — Windows 작업 스케줄러용 실행 래퍼
REM 매달 1회 실행되어 monitor_insurers.py를 돌리고, 로그를 남긴다.
REM 작업 스케줄러 등록은 pipeline/schedule_monitor.ps1 참조.

set PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
set PROJ=C:\projects\myguardian-v2
set LOG=%PROJ%\pipeline\monitor.log

cd /d "%PROJ%"
echo ==== %DATE% %TIME% 점검 시작 ==== >> "%LOG%"
"%PY%" pipeline\monitor_insurers.py >> "%LOG%" 2>&1
echo ==== %DATE% %TIME% 점검 종료 ==== >> "%LOG%"
