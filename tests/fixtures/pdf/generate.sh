#!/usr/bin/env bash
#
# generate.sh — extract-pdf.sh テスト用 fixture を再生成する。
#
# 通常のテストは commit 済み fixture を使う。本スクリプトは fixture が失われたり
# 更新が必要になった場合の再生成用途。
#
# 依存:
#   - python3 (Python 3.8+)        fixture PDF のハンドメイド生成
#   - qpdf                         暗号化 PDF 生成
#   - magick (ImageMagick)         スキャン画像 PDF 生成
#
# 実行:
#   bash tools/claude-brain/tests/fixtures/pdf/generate.sh

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "${HERE}"

for bin in python3 qpdf magick; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "ERROR: ${bin} not found. Install poppler / qpdf / imagemagick." >&2
    exit 1
  fi
done

python3 "${HERE}/make-pdf.py"

# 暗号化 PDF: sample-8p.pdf を 256bit AES で保護 (user-password=空・owner-password=test)。
# 空の user-password を使うと pdfinfo がメタデータを読めるので extract-pdf.sh の
# "Encrypted: yes" 検出パスをテストできる。
qpdf --encrypt --owner-password=test --user-password= --bits=256 -- \
  sample-8p.pdf sample-encrypted.pdf

# スキャン画像 PDF: 1 ページの空白画像 (テキストレイヤーなし)
# magick の -size + canvas で空白ページを作り PDF に変換
magick -size 612x792 xc:white -density 72 sample-scanned.pdf

echo "Generated fixtures:"
ls -la *.pdf
