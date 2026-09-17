@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo   实习日报一点通 — 一键发布更新
echo ============================================
echo.
echo 正在收集改动...
git add -A
git commit -m "网站更新 %date% %time%" >nul 2>&1
if errorlevel 1 (
  echo 没有检测到新改动，继续检查是否需要同步到线上...
)
echo 正在推送到 GitHub...
git push
if errorlevel 1 (
  echo.
  echo [提示] 常规推送失败（本机到 github.com 的连接经常被掐断）。
  echo        改用 GitHub API 通道发布...
  set "PYEXE=C:\Users\ASUS\.workbuddy\binaries\python\versions\3.13.12\python.exe"
  if not exist "%PYEXE%" set "PYEXE=python"
  "%PYEXE%" "..\hmz_work\api_push.py"
  if errorlevel 1 (
    echo.
    echo [失败] 两条通道都没成功：请检查网络后重新双击本文件。
    pause
    exit /b 1
  )
)
echo.
echo [完成] 发布成功！约 1 分钟后刷新网页即可看到新版。
echo 网址：https://youxialy.github.io/haomingzi/
echo.
pause
