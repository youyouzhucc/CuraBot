#!/bin/bash
# CuraBot 一键部署脚本
# 用法: ./deploy.sh
# 功能: git pull → 保留 .env → npm install → PM2 重启

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================="
echo "  CuraBot 一键部署"
echo "========================================="
echo "📁 目录: $SCRIPT_DIR"
echo ""

# 1. 保留 .env
if [ -f .env ]; then
  cp .env .env.backup
  echo "✅ .env 已备份"
else
  echo "⚠️  没有 .env 文件，部署后需要配置"
fi

# 2. 拉取最新代码
echo ""
echo "📥 拉取最新代码..."
git pull origin main
echo "✅ 代码已更新"

# 3. 恢复 .env
if [ -f .env.backup ]; then
  cp .env.backup .env
  echo "✅ .env 已恢复"
fi

# 4. 安装依赖
echo ""
echo "📦 安装依赖..."
npm install --production 2>&1 | tail -3
echo "✅ 依赖已安装"

# 5. 验证 JSON
echo ""
echo "🔍 验证知识库..."
node -e "JSON.parse(require('fs').readFileSync('public/data/knowledge.json','utf8')); console.log('✅ knowledge.json 格式正确');"

# 6. PM2 重启
echo ""
if command -v pm2 &> /dev/null; then
  if pm2 list | grep -q "CuraBot"; then
    pm2 restart CuraBot
    echo "✅ PM2 已重启 CuraBot"
  else
    pm2 start server.js --name CuraBot
    echo "✅ PM2 已启动 CuraBot"
  fi
  pm2 save
else
  # 没有 PM2，用传统方式重启
  echo "⚠️  未检测到 PM2，使用传统方式重启..."
  OLD_PID=$(lsof -t -i:3000 2>/dev/null || true)
  if [ -n "$OLD_PID" ]; then
    kill $OLD_PID 2>/dev/null || true
    sleep 1
    echo "✅ 旧进程已停止 (PID: $OLD_PID)"
  fi
  nohup node server.js > output.log 2>&1 &
  echo "✅ 新进程已启动 (PID: $!)"
fi

# 7. 等待启动 + 验证
sleep 2
echo ""
echo "🧪 验证服务..."
RESULT=$(curl -s -m 5 http://localhost:3000/api/chat-local \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"message":"测试","species":"cat","style":"greeting"}' 2>/dev/null || echo "FAIL")

if echo "$RESULT" | grep -q '"reply"'; then
  echo "✅ 服务正常运行！"
else
  echo "❌ 服务可能异常，请检查日志："
  echo "   pm2 logs CuraBot  或  tail -50 output.log"
fi

echo ""
echo "========================================="
echo "  部署完成！"
echo "========================================="
