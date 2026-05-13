# visualizer-empty-vault fixture

Sprint 3 v0.8 β Phase 4 — CI screenshot regression test 用の "empty Vault" 再現 fixture。

意図的に **ファイルが README.md だけ**。 `tests/fixtures/visualizer-vaults.mjs` の
`cloneEmptyVault(tmpDir)` でこのディレクトリ構造をコピーし、`git init` + initial commit
を tmpDir 上で行うことで「育っていない Vault」状態を再現する。

acceptance criteria (handoff §Phase 4):
- ✅ empty Vault state で「まだ育っていない」を丁寧表示 (破綻しない)
- ✅ first_view = null OR 全 layer empty で graceful render
- ✅ auto-lint drawer は "未実行" 案内のみ表示

このディレクトリには `wiki/` 配下を含めない (本物の empty を表現)。
