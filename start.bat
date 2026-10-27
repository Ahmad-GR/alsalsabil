@echo off
chcp 65001 > nul
title أكاديمية القرآن والسنة - Server

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║     أكاديمية القرآن والسنة - تشغيل السيرفر   ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: التحقق من Node.js
node --version > nul 2>&1
if %errorlevel% neq 0 (
  echo  ❌ Node.js غير مثبت!
  echo  📥 حمّله من: https://nodejs.org
  pause
  exit
)

:: الانتقال لمجلد server
cd /d "%~dp0server"

:: تثبيت الحزم إذا لم تكن موجودة
if not exist "node_modules" (
  echo  📦 تثبيت الحزم... قد يستغرق دقيقة
  npm install
  echo.
)

:: التحقق من .env
if not exist ".env" (
  echo  ⚠️  ملف .env غير موجود!
  echo  📋 انسخ .env.example وعدّله بالبيانات الصحيحة
  pause
  exit
)

echo  ✅ كل شيء جاهز! جاري تشغيل السيرفر...
echo  🌐 افتح المتصفح على: http://localhost:5000
echo.
echo  اضغط Ctrl+C لإيقاف السيرفر
echo  ══════════════════════════════════════════════
echo.

npm run dev
pause
