# Domain の入口

| Domain | Backend 入口 | Web 入口 | 所有する試験 |
| --- | --- | --- | --- |
| conversation | `api/domains/conversation/index.ts` | `web/src/domains/conversation/index.ts` | `api/domains/conversation/test/` |
| continuity | `api/domains/continuity/index.ts` | `web/src/domains/continuity/index.ts` | `api/domains/continuity/test/`、`web/src/domains/continuity/test/` |
| larm | `api/domains/larm/index.ts` | なし | `api/domains/larm/test/` |
| audio | なし | `web/src/domains/audio/index.ts` | `web/src/domains/audio/test/` |
| queue | `api/domains/queue/index.ts` | なし | `api/domains/queue/test/` |
| scheduler | `api/domains/scheduler/index.ts` | なし | `api/domains/scheduler/test/` |
| dialogue | `api/domains/dialogue/index.ts` | `web/src/domains/dialogue/index.ts` | `api/domains/dialogue/test/`、`web/src/domains/dialogue/test/` |
| voice-dialogue | `api/domains/voice-dialogue/index.ts` | `web/src/domains/voice-dialogue/index.ts` | `api/domains/voice-dialogue/test/`、`web/src/domains/voice-dialogue/test/` |

backend の HTTP 組立ては `api/application/`、SQLite の排他・接続・migration 実行は `api/infrastructure/sqlite/`、Web と CLI の共通 HTTP 搬送は `client/` が所有します。domain 間 import の方向は `scripts/domains.ts` と `scripts/boundaries.ts` が検査します。`bun run test:domain -- <name>` は所有試験のみ、`bun run verify -- --domain <name>` は format、lint、型依存閉包、境界、試験を確認します。
