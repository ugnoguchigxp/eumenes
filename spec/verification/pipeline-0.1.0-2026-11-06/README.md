# 検証記録（pipeline 0.1.0、2026-11-06）

- `verify-report.json`・`verify-final.log`: `bun run verify -- --domain pipelines --domain agent-runtime --domain capabilities --domain tool-runtime --domain dialogue` の結果。成功、API 990件、Web 32件。
- 実施場所: 独立コピー（共有作業フォルダでは開発サーバーが稼働中だったため）。
  - 本体 `ed0b602e` を `git archive` で展開し、コピー内だけで基準commitを作った。reportの `baseCommit` は、そのコピー内のcommit `85a259ca` である。
  - そこへ `verified-diff.patch`（共有フォルダの `git diff --binary`）と、未追跡の新規ファイル（本書のspec、0.1.0のtarballと `.sha256`）を当てた。
- size-budgetの警告 `api/domains/memory/service/index.ts#createMemoryService` は、今回の変更範囲外にある既存の警告である。
