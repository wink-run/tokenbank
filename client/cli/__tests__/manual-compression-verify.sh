#!/bin/bash
# 手动验证 HTTP 压缩功能的快速脚本
# 用法: ./manual-compression-verify.sh [admin-port]

PORT=${1:-11431}

echo "=== 测试 HTTP 压缩功能 ==="
echo

# 测试 1: 带 gzip 的 HTML
echo "[1] HTML with Accept-Encoding: gzip"
curl -sI "http://127.0.0.1:$PORT/" -H "Accept-Encoding: gzip" | grep -E "(HTTP/|Content-Type|Content-Encoding|Vary|Content-Length)"
echo

# 测试 2: 不带 Accept-Encoding 的 HTML
echo "[2] HTML without Accept-Encoding"
curl -sI "http://127.0.0.1:$PORT/" | grep -E "(HTTP/|Content-Type|Content-Encoding|Vary|Content-Length)"
echo

# 测试 3: 拒绝 gzip
echo "[3] HTML with Accept-Encoding: gzip;q=0"
curl -sI "http://127.0.0.1:$PORT/" -H "Accept-Encoding: gzip;q=0" | grep -E "(HTTP/|Content-Type|Content-Encoding|Vary|Content-Length)"
echo

# 测试 4: JS 文件（如果存在）
echo "[4] Checking for JS assets..."
JS_FILE=$(curl -s "http://127.0.0.1:$PORT/" | grep -oP '(?<=src=")[^"]*\.js' | head -1)
if [ -n "$JS_FILE" ]; then
  echo "Found JS: $JS_FILE"
  echo "With gzip:"
  SIZE_GZIP=$(curl -s "http://127.0.0.1:$PORT$JS_FILE" -H "Accept-Encoding: gzip" --compressed -w "%{size_download}" -o /dev/null)
  echo "  Compressed size: $SIZE_GZIP bytes"
  SIZE_RAW=$(curl -s "http://127.0.0.1:$PORT$JS_FILE" -w "%{size_download}" -o /dev/null)
  echo "  Uncompressed size: $SIZE_RAW bytes"
  if [ "$SIZE_RAW" -gt 0 ]; then
    RATIO=$(echo "scale=1; $SIZE_GZIP * 100 / $SIZE_RAW" | bc)
    echo "  Compression ratio: $RATIO%"
  fi
else
  echo "No JS assets found in index.html"
fi
echo

# 测试 5: API 响应不应该被压缩
echo "[5] API response (should not be compressed)"
curl -sI "http://127.0.0.1:$PORT/api/gateway/status" -H "Accept-Encoding: gzip" | grep -E "(HTTP/|Content-Type|Content-Encoding|Vary)"
echo

echo "=== 测试完成 ==="
