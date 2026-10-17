#!/bin/sh
# 闪传 Flicker —— macOS / Linux 启动脚本
# 用法：双击（macOS 需先右键 → 打开），或在终端执行 ./启动.sh
set -e
cd "$(dirname "$0")"

echo
echo "  闪传 Flicker"
echo "  一次性文件传输 | 接收端零安装 | 用完即销毁"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  没有找到 Node.js。"
  echo
  echo "  闪传需要一个 Node.js 运行时。请到下面的地址下载安装："
  echo
  echo "      https://nodejs.org/    （选 LTS 版本）"
  echo
  if [ "$(uname)" = "Darwin" ]; then
    open "https://nodejs.org/" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "https://nodejs.org/" 2>/dev/null || true
  fi
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 24 ]; then
  echo "  你的 Node.js 版本太旧（当前 v$MAJOR，需要 v24 或更高）。"
  echo "  请到 https://nodejs.org/ 下载新版本覆盖安装。"
  exit 1
fi

exec node "bin/flicker.js" "$@"
