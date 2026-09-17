@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo   实习日报一点通 — 跑全部测试
echo ============================================
echo.
set FAILED=0

echo [1/4] 生成引擎（模块轮换 / 字数 / 相似度）...
node test\harness.js
if errorlevel 1 set FAILED=1
echo.

echo [2/4] 草稿暂存（切日期不丢内容）...
node test\draft.test.js
if errorlevel 1 set FAILED=1
echo.

echo [3/4] 备份码与导入校验（压缩 / 兼容 / 防 XSS）...
node test\backup.test.js
if errorlevel 1 set FAILED=1
echo.

echo [4/4] 真机冒烟（用 jsdom 把首页整个跑起来）...
node test\integration.test.js
if errorlevel 1 set FAILED=1
echo.

echo ============================================
if "%FAILED%"=="1" (
  echo [失败] 有测试没通过，先别发布。
) else (
  echo [通过] 全部测试通过，可以放心双击「更新网站.bat」发布。
)
echo ============================================
pause
