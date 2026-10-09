# Domain の入口

| Domain | Backend 入口 | Web 入口 | 所有する試験 |
| --- | --- | --- | --- |
| attitude-dataset | `api/domains/attitude-dataset/index.ts` | CLI/API（`docs/ruri-collection.md`） | `api/domains/attitude-dataset/test/` |
| delivery | `api/domains/delivery/index.ts` | なし | `api/domains/delivery/test/` |
| avatar | なし | `web/src/domains/avatar/index.ts` | `web/src/domains/avatar/test/` |
| service-tests | `api/domains/service-tests/index.ts` | `web/src/domains/service-tests/index.tsx` | `api/domains/service-tests/test/`、`web/src/domains/service-tests/index.test.tsx` |
| settings | `api/domains/settings/index.ts` | `web/src/domains/settings/index.tsx`（カテゴリ別の画面は `sections/`、共通部品は `shared.tsx`） | `api/domains/settings/test/`、`web/src/domains/settings/sections/*.test.tsx` |
| inference | `api/domains/inference/index.ts` | なし | `api/domains/inference/test/` |
| tts-dictionary | `api/domains/tts-dictionary/index.ts` | `web/src/domains/tts-dictionary/index.tsx` | `api/domains/tts-dictionary/test/` |
| conversation | `api/domains/conversation/index.ts` | `web/src/domains/conversation/index.ts` | `api/domains/conversation/test/` |
| continuity | `api/domains/continuity/index.ts` | なし | `api/domains/continuity/test/` |
| capabilities | `api/domains/capabilities/index.ts` | CLI/API | `api/domains/capabilities/test/` |
| tool-runtime | `api/domains/tool-runtime/index.ts` | なし | `api/domains/tool-runtime/test/` |
| agent-runtime | `api/domains/agent-runtime/index.ts` | `web/src/domains/agent-runtime/index.ts` | `api/domains/agent-runtime/test/`、`api/application/toolchain.test.ts`、`tests/browser/toolchain.spec.ts` |
| web-research | `api/domains/web-research/index.ts` | CLI/API | `api/domains/web-research/test/` |
| memory | `api/domains/memory/index.ts` | なし | `api/domains/memory/test/` |
| larm | `api/domains/larm/index.ts` | なし | `api/domains/larm/test/` |
| audio | なし | `web/src/domains/audio/index.ts` | `web/src/domains/audio/test/` |
| queue | `api/domains/queue/index.ts` | なし | `api/domains/queue/test/` |
| scheduler | `api/domains/scheduler/index.ts` | なし | `api/domains/scheduler/test/` |
| dialogue | `api/domains/dialogue/index.ts` | `web/src/domains/dialogue/index.ts` | `api/domains/dialogue/test/`、`web/src/domains/dialogue/test/` |
| voice-dialogue | `api/domains/voice-dialogue/index.ts` | `web/src/domains/voice-dialogue/index.ts` | `api/domains/voice-dialogue/test/`、`web/src/domains/voice-dialogue/test/` |

backend の HTTP 組立ては `api/application/`、SQLite の排他・接続・migration 実行は `api/infrastructure/sqlite/`、Web と CLI の共通 HTTP 搬送は `client/` が所有します。domain 間 import の方向は `scripts/domains.ts` と `scripts/boundaries.ts` が検査します。`export … from`、動的 `import()`、型 `import("…")` も同じ規則で検査し、`web/src` と `client` から `api` へは `api/domains/<domain>/contracts` だけ、`cli` からは `client`・contracts・`api/infrastructure/auth-config` だけを許します。`bun run test:domain -- <name>` は所有試験のみ、`bun run verify -- --domain <name>` は format、lint、型依存閉包、境界、試験を確認します。

Toolchainは `capabilities` が不変revision・候補検索・必須依存を、`tool-runtime` が所有者付き実行参照・入力検査・短期観測を、`agent-runtime` が制御step・子の予算・要約検査・採用ticketを所有します。既存Web取得を呼ぶadapterは `api/application/toolchain.ts` が組み立てます。下位domainは上位のSQLを参照しません。CLI/Webは共通clientからHTTPを使います。
