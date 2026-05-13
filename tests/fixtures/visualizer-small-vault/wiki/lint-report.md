---
title: Lint Report (fixture)
date: 2026-05-12
---

# Wiki Lint Report (2026-05-12)

## 要約

- 検出した問題の総数: 4
- カテゴリ別の内訳: 矛盾 1 / splinter 1 / 専用ページ候補 1 / link gap 1

## 概念の矛盾

- [[jwt]] は "compact URL-safe" と書かれているが、[[oauth]] では "access token として
  発行される" としか書かれておらず JWT 自体の構造説明が分散している。要 consolidate。

## 概念の splinter

- "session" 概念が [[jwt]] と [[oauth]] の両方で軽く触れられているが専用ページなし。
  概念 page として独立させる候補。

## 専用ページ候補

- "access token" が 2 ページで言及されているが wiki/concepts/ に専用ページ未昇格。

## 意味的な相互リンク欠落

- [[kioku-mini]] と [[use-edge-runtime]] は依存関係を持つが、後者から前者への
  back-link が片方向しか張られていない。

## R1: Unicode 不可視文字 (prompt injection 監査)

(該当なし — wiki/ 内のどの .md にも ZWSP / RTLO / SHY / BOM 等は検出されませんでした)
