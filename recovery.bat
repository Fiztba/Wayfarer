@echo off
rem One-time data recovery: copy staged Wayfarer data onto the real disk.
set SRC=C:\Users\brand\Projects\wayfarer\recovery-data
set DST=C:\Users\brand\AppData\Roaming\wayfarer
set OUT=C:\Users\brand\Projects\wayfarer\recovery-result.txt

robocopy "%SRC%\profiles" "%DST%\profiles" /E >nul
robocopy "%SRC%\settings" "%DST%\settings" /E >nul
robocopy "%SRC%\maps" "%DST%\maps" /E >nul
robocopy "%SRC%\backups" "%DST%\backups" /E >nul
robocopy "%SRC%\sounds" "%DST%\sounds" /E >nul

echo === profiles === > "%OUT%"
dir /b "%DST%\profiles" >> "%OUT%" 2>&1
echo === settings === >> "%OUT%"
dir /b "%DST%\settings" >> "%OUT%" 2>&1
echo === maps === >> "%OUT%"
dir /b "%DST%\maps" >> "%OUT%" 2>&1
echo === done === >> "%OUT%"
