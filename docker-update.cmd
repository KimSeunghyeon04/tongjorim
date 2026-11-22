@echo off
setlocal
pushd "%~dp0" || exit /b 1

docker compose up -d --build --force-recreate --wait --wait-timeout 60
set "result=%ERRORLEVEL%"

popd
if not "%result%"=="0" pause
exit /b %result%
