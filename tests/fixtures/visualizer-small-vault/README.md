# visualizer-small-vault fixture

Sprint 3 v0.8 β Phase 4 — CI screenshot regression test 用の "small Vault" 再現 fixture。

3-5 wiki page + 1 auto-lint report (4 観点 完備) の最小構成。Phase 1-4 で実装した
全 view (Overview / Timeline / Diff / Lineage) + auto-lint drawer が動作する最小入力。

`tests/fixtures/visualizer-vaults.mjs` の `cloneSmallVault(tmpDir)` がこの directory を
tmpDir にコピーし、`git init` + 2 commit (初期 ingest + concept 追加) を作って snapshot
時系列を作る。

## 構成

- `wiki/index.md` — entrance page (wikilink to concepts)
- `wiki/concepts/jwt.md` — concept page
- `wiki/concepts/oauth.md` — concept page (relates to jwt)
- `wiki/projects/kioku-mini.md` — project page
- `wiki/decisions/use-edge-runtime.md` — decision page
- `wiki/lint-report.md` — auto-lint report (4 観点全部に 1 件ずつ finding)

## acceptance criteria (handoff §Phase 4)

- ✅ small Vault state で各 view が動作 (破綻しない)
- ✅ 5 page で graph_preview hot_pages / active_projects / recent_decisions が non-empty
- ✅ auto-lint drawer 4 観点全部に finding 表示
- ✅ Timeline 2 snapshot 切替可
- ✅ Diff 2 snapshot 間の差分表示可

## 編集時の注意

このディレクトリは **screenshot regression test の固定入力**。
意図的な内容変更 (新 view 追加で fixture も拡張する等) 以外で wiki/ 配下を変えると
BLUE-VIZ-SCREENSHOT-* の期待値が drift するため CI fail する。
