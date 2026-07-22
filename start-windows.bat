@echo off
chcp 65001 >nul
cd /d %~dp0
where py >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Python。
  echo 请先安装 64 位 Python 3.12，并在安装时勾选 Add Python to PATH。
  pause
  exit /b 1
)
if not exist .venv (
  echo 首次运行：正在创建运行环境...
  py -m venv .venv
  if errorlevel 1 (
    echo [错误] 创建运行环境失败。
    pause
    exit /b 1
  )
  echo 正在安装依赖，请保持网络连接...
  .venv\Scripts\python.exe -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重新运行。
    pause
    exit /b 1
  )
)
echo.
echo 正在启动发货清单...
echo 本机地址：http://127.0.0.1:8765
echo 其他内网电脑请使用：http://本机IPv4地址:8765
echo 请保持本窗口开启。按 Ctrl+C 可以停止服务。
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8765'"
.venv\Scripts\waitress-serve.exe --host=0.0.0.0 --port=8765 app:app
if errorlevel 1 (
  echo.
  echo [错误] 网站启动失败，请保留本窗口并拍照发送错误内容。
  pause
)
