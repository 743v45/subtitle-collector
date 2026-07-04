#!/usr/bin/env bash
# 用法：bash scripts/load-collector-extension.sh
# 在 chrome://extensions/ 开发者模式加载此目录：apps/subtitle-collector/dist
set -e
EXT_DIR="$(cd "$(dirname "$0")/../apps/subtitle-collector/dist" && pwd)"
echo "扩展目录: $EXT_DIR"
echo "在 chrome://extensions/ 打开开发者模式，点击'加载已解压的扩展程序'，选择："
echo "  $EXT_DIR"
echo ""
echo "依赖服务（运行中才能上报）："
echo "  cd apps/collector-server && pnpm dev"
