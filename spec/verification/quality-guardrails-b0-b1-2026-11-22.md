# 初期 JS 容量・初回操作時間 検証記録（B0〜B3、2026-11-22）

- 日付: 2026-11-22
- 基準コミット: `dac16e45`（作業ツリー）
- 実施環境: 独立した固定コピー `/tmp/eumenes-b0-verify-2026-11-22`（製品 DB・鍵・`.env`・ログは非複製、`@eumenes/*` と `packages/design-system/dist` をコピー内で独立ビルド）。Bun 1.4.4 / Vite 8.3.5 / Chromium headless（Playwright）。
- 関連計画: [品質ガードレール適正化・軽量化・運用持続可能性 改善計画書](../quality-guardrails-and-sustainability-plan-2026-11-22.md)（§3.4 `B0`〜`B3`・§6 論点 3）、[EUM010](../project-issues-2026-11-06.md#eum010-初期javascript容量の超過記録を閉じていない)

## 1. B0: 初期チャンク内訳と分類（`B1` 適用前、source map なし `initialGzip = 324,127 B`）

手元 checkout の古い `dist-web`（2026-11-09、`359,294 B`）ではなく、固定コピーで最新コードをビルドした結果を `sourcemap` で解析した上位チャンク内訳（全 57 チャンク、source map あり時合計 `326,232 B`、source map なし `324,127 B`）:

| チャンク | gzip (map あり) | 主な含有モジュール | 分類 |
| --- | ---: | --- | --- |
| `assets/react-*.js` | 56,644 B | `react-dom`, `scheduler` | 初期表示に必要 |
| `assets/index-*.js` | 53,450 B | `useVoiceDialogue`, `NotificationCenter`, `TimerNotifications`, `MessageList` 等 | 初期表示に必要 |
| `assets/client-*.js` | **45,531 B** | **`zod@4.6.7`**（`eumenes-agency` / `memory-host` / `pipeline` 経由で二重解決）＋ `client/` | **費用小で削減可（`zod` 重複排除）** |
| `assets/schemas-*.js` | **20,381 B** | **`zod@4.4.3`**（root / `artifact-ui` の固定版） | 初期表示に必要（`zod` 1 本化で統合） |
| `assets/toolchain-artifacts-*.js` | 15,718 B | `@radix-ui/react-select`, `toolchain-adapters`, `markdownRenderer` | 初期表示に必要（一部は構造変更要） |
| `assets/query-*.js` | 14,362 B | `@tanstack/query-core`, `react` | 初期表示に必要 |
| `assets/contracts-*.js` (capabilities) | 12,154 B | `capabilities/contracts/*` | 遅延には構造変更が要る（`client/` 分割） |
| `assets/Button-*.js` | 10,934 B | `tailwind-merge`, `Button`, `cva` | 初期表示に必要 |
| `assets/Modal-*.js` | 8,991 B | `@radix-ui/react-dialog`, `dismissable-layer`, `focus-scope` | 初期表示に必要 |
| `assets/floating-ui.react-dom-*.js` | 8,400 B | `@floating-ui/*` | 初期表示に必要（Select/DropdownMenu） |
| `assets/audio-*.js` | 7,864 B | `audio/controller`, `useTimerTone`, `speech-detector` | 初期表示に必要 |
| その他契約・UI・背景（46 チャンク） | ~69.8 KB | 各 domain contracts, `Tabs`, `settings`, `SpatialBackground`, `ErrorReportDialog` 等 | 多くは `client/index.ts` 全量 import 由来（遅延には構造変更が要る） |

### 判明した最大の原因（費用小）
- 全ワークスペースが `zod@4.4.3` を指定している一方、`vendor/` パッケージ（`eumenes-agency`, `eumenes-memory-host`, `eumenes-pipeline`）の依存で `zod@4.6.7` が別解決され、**`zod` が 2 バージョン（計 65.9 KB gzip）初期ロードに二重バンドル**されていた。

## 2. B1: 適用した改修（費用小・構造不変）

- [vite.config.ts](../../vite.config.ts): `command === "build"` のみ `resolve: { dedupe: ["zod"] }` を追加し、ビルド時の `zod` 二重バンドルを解消した。画面構成・公開 API・パッケージエントリは不変。

## 3. 前後比較（同一条件：固定コピー＋ヘッドレス Chromium・モック API 5 回計測）

| 指標 | B0（適用前） | B1（適用後） | 差分 |
| --- | ---: | ---: | ---: |
| `entryGzip`（source map なし） | 53,417 B | **53,416 B** | -1 B（旧基準 112,035 B から **-52.3%**） |
| `initialGzip`（source map なし） | 324,127 B | **299,799 B** | **-24,328 B（-7.5%）** |
| 初回チャット入力可能（5 回中央値） | 167 ms（157〜1230） | **170 ms（147〜176）** | +3 ms（悪化なし・コールドスパイク解消） |
| 初回 Artifact 表示（5 回中央値） | 5,732 ms（3189〜5871） | **5,890 ms（2042〜7044）** | +158 ms（最短 2,042 ms・同等水準） |
| `pageerror` 件数 | 0 | **0** | 変化なし |

## 4. B3: 基準値の更新と EUM010 の扱い

- §6 論点 3 の合意に基づき、構造分割（`B2`）は行わず、[scripts/bundle-budget.json](../../scripts/bundle-budget.json) を実測値（`entryGzip: 53416`, `initialGzip: 299799`）へ更新した。
- 固定コピー側で `bun scripts/bundle-budget.ts` が `ok` となることを確認済み。
