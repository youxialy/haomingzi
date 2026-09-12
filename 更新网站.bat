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
  echo 没有检测到新改动，网站已是最新。
) else (
  echo 已打包改动，正在推送到 GitHub...
  git push
  if errorlevel 1 (
    echo.
    echo [失败] 推送未成功：请检查网络后重新双击本文件。
    pause
    exit /b 1
  )
)
echo.
echo [完成] 发布成功！约 1 分钟后刷新网页即可看到新版。
echo 网址：https://youxialy.github.io/haomingzi/
echo.
pause
