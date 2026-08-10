@echo off
chcp 65001 >nul 2>&1
title TopkapiAl CAD Backend (Gelistirme)

echo ============================================
echo   TopkapiAl - Gelistirme Modu
echo   Dosya degisikliklerinde otomatik yeniden
echo   baslatma aktif (--watch)
echo ============================================
echo.

cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [HATA] Node.js bulunamadi!
    pause
    exit /b 1
)

if not exist .env (
    copy .env.example .env >nul
    echo [BILGI] .env olusturuldu, API_KEY degerini girin.
)

if not exist node_modules (
    echo [YUKLE] npm install...
    call npm install
)

if not exist output mkdir output
if not exist data mkdir data

echo.
node --watch src/server.js
