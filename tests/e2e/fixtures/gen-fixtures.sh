#!/usr/bin/env bash
# E2E fixtures 程序化生成（定稿 §2.5 冻结规格：VP8/Opus WebM、≤10s、ffmpeg 生成入仓）。
# M0 不生成实体文件（E2E 属 M1/M2）；M1 开工时在本目录执行本脚本。
set -euo pipefail
cd "$(dirname "$0")"

# 10 秒 320x180 VP8/Opus WebM（含 1kHz 测试音，供调度断言与听感冒烟）
ffmpeg -y \
  -f lavfi -i "testsrc2=size=320x240:rate=25:duration=10" \
  -f lavfi -i "sine=frequency=1000:duration=10" \
  -c:v libvpx -b:v 200k -c:a libopus -b:a 48k \
  fixture-vp8-opus-10s.webm

echo "已生成 fixture-vp8-opus-10s.webm"
