@echo off
REM =============================================================
REM  Allow Vite/Hono dev servers through Windows Firewall so
REM  phones on the same Wi-Fi can reach the /worker portal.
REM
REM  How to run:  DOUBLE-CLICK this file.
REM  Windows will ask "allow this app to make changes?" -> Yes.
REM  You only need to do this ONCE — survives reboot.
REM =============================================================

REM ---- Auto-elevate: if not admin, re-launch ourselves with UAC ----
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator permission...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo === Hookka ERP dev firewall setup ===
echo.

echo [1/3] Removing any Node.js BLOCK rules Windows auto-added...
powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName 'Node.js JavaScript Runtime' -ErrorAction SilentlyContinue | Where-Object Action -EQ Block | Remove-NetFirewallRule"

echo [2/3] Clearing any old Hookka dev rule...
netsh advfirewall firewall delete rule name="Hookka ERP Dev (ports 3000-3002)" >nul 2>&1

echo [3/3] Adding ALLOW rule for TCP 3000-3002 (any profile)...
netsh advfirewall firewall add rule ^
    name="Hookka ERP Dev (ports 3000-3002)" ^
    dir=in ^
    action=allow ^
    protocol=TCP ^
    localport=3000-3002 ^
    profile=any

if %errorlevel% neq 0 (
    echo.
    echo [FAILED] Could not add rule.  This shouldn't happen -- check
    echo          that Windows Firewall service is running.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   [OK] Firewall is open.  On your phone (same Wi-Fi), go to:
echo        http://192.168.100.25:3000/worker/login
echo ============================================================
echo.
pause
