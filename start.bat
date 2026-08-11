@echo off
chcp 65001 >nul 2>&1
title TopkapiAl CAD Backend

echo ============================================
echo   TopkapiAl - Yapay Zeka Destekli CAD
echo   Backend Sunucusu Baslatiliyor...
echo ============================================
echo.

REM Calisma dizinine git
cd /d "%~dp0"

REM Node.js kontrol
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [HATA] Node.js bulunamadi!
    echo Node.js 18+ yukleyin: https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do echo [OK] Node.js: %%v

REM .env dosyasi kontrol
if not exist .env (
    echo [UYARI] .env dosyasi bulunamadi, .env.example kopyalaniyor...
    copy .env.example .env >nul
    echo [BILGI] .env dosyasini duzenleyin: API_KEY degerini girin.
    echo.
)

REM Bagimliliklari yukle (node_modules yoksa veya package.json degismisse)
if not exist node_modules (
    echo [YUKLE] npm install calistiriliyor...
    call npm install
    if %errorlevel% neq 0 (
        echo [HATA] npm install basarisiz!
        pause
        exit /b 1
    )
    echo [OK] Bagimliliklar yuklendi.
    echo.
)

REM Output dizinini olustur
if not exist output mkdir output
if not exist data mkdir data

REM Claude CLI kontrol
where claude >nul 2>&1
if %errorlevel% neq 0 (
    echo [UYARI] Claude CLI bulunamadi. Dogal dil ozellikleri calismayacak.
    echo         Yuklemek icin: npm install -g @anthropic-ai/claude-code
) else (
    echo [OK] Claude CLI mevcut
)

REM uvx (FreeCAD MCP) kontrol
where uvx >nul 2>&1
if %errorlevel% neq 0 (
    echo [UYARI] uvx bulunamadi. FreeCAD MCP baglantisi calismayacak.
    echo         Yuklemek icin: pip install uv
) else (
    echo [OK] uvx mevcut
)

echo.
echo ============================================
echo   Sunucu baslatiliyor...
echo   Durdurmak icin: Ctrl+C
echo ============================================
echo.

node src/server.js

if %errorlevel% neq 0 (
    echo.
    echo [HATA] Sunucu beklenmedik sekilde durdu.
    pause
)
