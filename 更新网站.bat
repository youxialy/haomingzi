@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo   实习日报一点通 — 一键发布更新
echo ============================================
echo.
echo 正在运行全部测试（发布前门禁）...
call 跑测试.bat auto
if errorlevel 1 (
  echo.
  echo [中止] 有测试未通过，已停止发布。请先修复，再重新双击本文件。
  pause
  exit /b 1
)
echo 测试全部通过，继续发布。
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

  set "DEPLOY="
  if exist "%~dp0..\_tools\api_deploy.py" set "DEPLOY=%~dp0..\_tools\api_deploy.py"
  if not defined DEPLOY if exist "%USERPROFILE%\.workbuddy\skills\github-pages-api-deploy\scripts\api_deploy.py" set "DEPLOY=%USERPROFILE%\.workbuddy\skills\github-pages-api-deploy\scripts\api_deploy.py"
  if not defined DEPLOY if exist "%~dp0..\hmz_work\api_push.py" set "DEPLOY=%~dp0..\hmz_work\api_push.py"
  if not defined DEPLOY (
    echo [失败] 找不到 api_deploy.py，应在 ..\_tools\ 目录下。
    pause
    exit /b 1
  )

  set "PYEXE="
  if exist "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe" set "PYEXE=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
  if not defined PYEXE if exist "D:\python\python.exe" set "PYEXE=D:\python\python.exe"
  if not defined PYEXE set "PYEXE=python"

  echo 使用: %DEPLOY%
  "%PYEXE%" "%DEPLOY%"
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
