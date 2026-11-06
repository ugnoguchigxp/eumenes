# Eumenes Pipeline 0.1.0 取込み（解析・原文・実行可否の強化）

2026-11-06。利用者は、eumenes_pipeline の[改善設計書](../../eumenes_pipeline/docs/plans/improvement-design-2026-11-06.md)を本体へ反映して使えるようにすることを許可した。あわせて次の2点を選んだ。

- 計画の指示文は、本体のbundleデータ（`pipeline-execution`）のまま維持する。
- 別作業の未commit差分に重ねて作業し、commitは保留する。

本書は [p0-3取込み](pipeline-p0-3-integration-2026-11-05.md) の続きで、編集前の範囲と受入を記録する。

## 目的と範囲

p0-3取込みの経路（会話入口、bundle、親実行、子実行、参照、配送）は変えず、ライブラリ0.1.0の3点を取り込む。

| 変更 | 内容 | 根拠 |
| --- | --- | --- |
| 厳格なJSON解析 | 計画出力の `JSON.parse` を `parseJsonStrict` に置き換える。重複キー・深さ超過を構造不備として、既存の一回の修復へ渡す | `JSON.parse` は重複キーの最後を黙って採用し、検査前の値が変わりうる |
| 原文の結び付け | モデルが返した `ready` 定義の `request` を、ホストの保持する原文へ置き換えてから検査する。置換前の文と一致の有無を親状態 `pipeline.requestEcho` に残す | pipelineの実API評価で、Lunaの機械的失敗2/24はどちらも原文の書写し誤り（言い換え、資料名の付加）だった |
| 実行可否の多層検査 | ライブラリ側でも、無効・excluded・session/task/pipeline等の入口を計画に入れない | 部品の写像（`component-catalog.ts`）の絞込みに加えた防御 |

**変えないこと**

- 指示文・カード・bundleのrevision。契約版はp0-3のまま（定義のJSON形は不変）。
- 協調作業の下書き（`startPipelineInTransaction` の `definition`）は利用者が確認した文書なので、結び付けを使わない。原文と違えば従来どおり拒否する。
- 意味判断、語句による分岐、新しい実行ループ・台帳・画面・サーバー操作、CI、モデル名の固定。

**原文の扱い**: 実行計画は常にホストの原文を持つ。モデルの改変は計画へ伝わらず、記録だけが残るので、p0-3の「モデルによる改変を拒否する」という意図は保たれる。変わるのは、改変だけを理由に修復を1回消費して停止していた挙動である。忘却では `pipeline` 状態ごと消えるため、`requestEcho.written` も残らない。

## 変更箇所

- `vendor/pipeline/`: 0.1.0のtarball、`.sha256`、manifest。旧0.0.0のtarballは消さずに残す。
- `package.json`・`bun.lock`: 依存を0.1.0へ。
- `api/domains/pipelines/service/definition.ts`: 解析と結び付けの公開口を、このdomainの唯一の実装として追加する。
- `api/domains/agent-runtime/service/execution-compose.ts`・`repository/executions.ts`: 解析の置換、結び付け、`requestEcho` の保存。
- 試験: `vendor.test.ts`、`pipeline-execution.test.ts`。

## 受入

1. vendorのchecksum・manifest・lock・導入済みruntimeが一致し、0.1.0の公開口がある。
2. 改変された原文は原文へ結び付いて実行され、修復を消費しない。`requestEcho` に置換前の文が残る。
3. 重複キーの出力は構造不備として一回だけ修復され、2回目も不備なら停止する。
4. 協調作業の下書きは、原文が違えば従来どおり拒否する。
5. `bun run verify -- --domain` で pipelines、agent-runtime、capabilities、tool-runtime、dialogue が成功する。

## 実装・検証結果

2026-11-06。上記の範囲を実装した。本体のcommit・pushはしていない。

**配布物**

- `eumenes-pipeline-0.1.0-a859fd16ce46.tgz`。SHA-256は `4c60c46ab77040b3ff4ed23433ca0ae9bd2e689efb8ea1db67da9234d8570f4f`、33ファイル。契約はp0-3のまま。
- pipeline側の未commit差分から作ったため、manifestは `dirty: true` になっている。内容の識別は `sourceDigest` で行う。
- 旧0.0.0のtarballは `vendor/pipeline/` に残した。

**原文の記録**

- `requestEcho` は、一致すれば `{matched:true}` だけを残す。
- 不一致なら、先頭500文字と全体の長さを残す。言い換えが長くても、親状態の65,536バイト上限を押し上げないための上限である（独立レビューの指摘）。

**独立レビュー**: 1回実施した。重大な指摘は0件。中〜低の指摘のうち、本体に関わる記録の上限・試験の追加・コメントの誤りは修正した。

| 受入 | 結果・根拠 |
| --- | --- |
| 1. vendorの照合と公開口 | `vendor.test.ts` が成功。checksum・manifest・lock・導入済みruntimeが一致し、`version 0.1.0`・`parseJsonStrict`・`bindSourceRequest`・`isRunnable` がある |
| 2. 改変された原文 | 原文へ結び付き、修復なし（計画呼出し1回）で完了する。定義と実行計画のrequestは原文。`requestEcho` に置換前の文と長さが残る |
| 3. 重複キー | 1回目は `invalid_json:duplicate_key@…` で修復し、2回目が正しければ完了する。2回とも重複なら修復1回の後に `pipeline_definition_invalid` で停止し、子は0件 |
| 4. 協調作業の下書き | 原文が同じ下書きは開始でき、違えば `pipeline_definition_invalid` で拒否する |
| 追加 | 一致時の記録、500文字の切り詰め、忘却で `pipeline` 状態ごと消えて行のどこにも置換前の文が残らないことを確認した |
| 5. 関係domainのverify | pipelines・agent-runtime・capabilities・tool-runtime・dialogueで成功。API 990件、Web 32件。型・境界・SQL・size・lint・整形・SystemContext・DesignSystemの型とbuildも成功 |

記録は [verification/pipeline-0.1.0-2026-11-06/](verification/pipeline-0.1.0-2026-11-06/) に置いた。

- **実施場所**: 共有作業フォルダでは開発サーバーが稼働していたため、`ed0b602e` を展開した独立コピーに今回の差分を当てて実施した。共有フォルダの差分と、検証した差分が一致することを照合済み。
- **size-budgetの警告**: memory serviceの既存の警告で、今回の範囲外。
- **この検証に含まないもの**: 実モデル（LARM）での計画と、画面での確認。稼働中の開発サーバーは再起動していないので、0.1.0を使うには再起動が必要。
