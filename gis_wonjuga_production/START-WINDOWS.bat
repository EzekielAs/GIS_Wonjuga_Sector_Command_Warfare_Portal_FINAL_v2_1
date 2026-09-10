@echo off
setlocal
cd /d "%~dp0"
if not exist .env (
  copy /Y .env.example .env >nul
  echo.
  echo .env has been created from .env.example.
  echo Edit .env now and set DB_PASSWORD, JWT_SECRET, ADMIN_PASSWORD and payment settings.
  echo Then run this file again.
  pause
  exit /b 1
)
where docker >nul 2>&1
if errorlevel 1 (
  echo Docker was not found. Install Docker Desktop first.
  pause
  exit /b 1
)
echo Starting GIS Wonjuga Sector Command Warfare Portal...
docker compose up -d --build
if errorlevel 1 (
  echo Startup failed. Check Docker Desktop and the values in .env.
  pause
  exit /b 1
)
echo.
echo Portal started at http://localhost:8080
echo.
echo Seeding the Main Administrator...
docker compose exec app npm run seed
start "GIS Wonjuga Portal" http://localhost:8080
pause
