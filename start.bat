@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install Node.js 22 LTS or newer from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing packages, please wait...
  call npm install --omit=dev || (pause & exit /b 1)
)
if not exist data\workflow.db (
  if exist "%USERPROFILE%\Downloads\Import_File_Current_Tasks_02-11-2026.csv" (
    echo Importing checklist...
    node scripts\import-csv.js "%USERPROFILE%\Downloads\Import_File_Current_Tasks_02-11-2026.csv"
  )
)
start "" http://localhost:3000
node server.js
pause
