# 独立 MemorySystem と Eumenes の接続計画

2026-10-09 改訂（実装状況）: 下の E1/E2 の最小接続は実装済み（隔離 DB の結合試験まで。実モデル・実機器は未実施）。
現行コードに合わせた差分: 旧 continuity は撤去済みだったため、`api/domains/continuity`（目的・決定・未解決事項）を新設し、
`api/domains/memory`（明示登録・停止・再開・訂正・忘却、外部 journal、採用時検証、利用記録、設定 ON/OFF）を追加した。
配布物は `vendor/eumenes-memory/`（版・sha256・DB スキーマ版は manifest.json）。dialogue は prepare で View v2 を固定し、
settle の採用 transaction で `validateMemoryViewV2` を通す（失敗は `memory_stale` で理由つき終了。自動再生成はしない）。
Memory の journal は DB の外（`EUMENES_MEMORY_JOURNAL`、既定は DB と同じディレクトリ）に置き、起動時に queue / worker より前に reconcile する。
Web の「設定 → メモリー」で会話への接続・非接続を切り替えられる。変更は即時保存し、再起動後も維持する。
非接続でも保存済みデータと忘却操作は維持し、会話履歴は従来どおり使う。生成中に切断した場合は、再接続しても切断前の view の回答を採用しない。
接続設定が ON でも journal 等が不健全なら「利用停止中」と表示する。World はまだ接続しておらず、切替項目も設けない。
未実装: 記憶の一覧・編集用 Web UI（CLI `bun cli/index.ts memory ...` と API のみ）、抽出由来の候補の接続（モデル adapter）、複数 scope・選択契約・
公開版の対話への結線、Episode / World。

2026-10-07 / 実装前。旧「Eumenes 内で本体を育ててから切り出す」構想を置き換える。本体は最初から隣接する `eumenes_memory` で開発する。

- [MemorySystem 実装計画の正本](../../eumenes_memory/spec/implementation-plan.md)
- [初期の公開契約](../../eumenes_memory/spec/contracts-v0.md)
- [SAAA 全体評価](../../eumenes_memory/spec/saaa-memory-system-review.md)

この文書には Eumenes 側の最小変更だけを記す。本体の view 構成、検索、Records、状態台帳、自動抽出、World は別リポジトリの責任とする。

後から接続するために Eumenes 側へ残す資料であり、本体ソースをこのリポジトリへ合流・コピーする指示ではない。接続には版を固定した配布パッケージを使う。

## 1. Eumenes に置くもの

| 部分 | 役割 |
|---|---|
| ConversationSourceAdapter | 会話の公開操作から、原文参照・版・digest・状態を作る |
| ContinuityStateAdapter | 既存 snapshot と stateRevision を共通契約へ変換する |
| MemoryClient | 本体の公開パッケージを呼ぶ薄い利用層。共通型を複製しない |
| dialogue の採用接続 | 生成に使った view を保持し、採用時に最新状態と照合する |
| UsageReceipt | run / attempt と実際に渡した入力・版・viewDigest の利用記録 |
| ホスト結合テスト | 変更・取消・原文欠落・再起動と採用の競合を検証する |

初期の配置候補は `api/domains/memory` の adapters / service とその試験。業務判断の共通コア、独自の検索索引、Memory 用の別 queue は置かない。UI や独立 HTTP API は最初の接続には必要ない。

## 2. 維持する所有関係

conversation が原文を、continuity が goal / decision / open_question と履歴を所有する。既存ブックマークの書き込み先は変えない。Memory 本体は snapshot を使い、同じ状態の第二の台帳を作らない。

queue / scheduler は attempt・lease・資源枠・再試行を所有する。資格情報と LARM 接続は backend に残す。SQLite 接続と writer は既存 infrastructure を使う。Memory の共通処理から Eumenes の内部 repository を呼ばせない。

原文の revision がなければ digest に基づく安定した不透明な版をアダプターが発行する。Continuity の stateRevision と原文版は区別する。将来の本体への正本移管は別の migration 計画とし、接続の必須条件にしない。

## 3. 実装順

### E0 — 本体の M0 を待つ間にできること

本体の契約を参照し、現在の公開操作との対応表、入力例、結合受入シナリオを準備する。稼働中の queue / continuity の実装を確認し、必要な公開操作だけを列挙する。本体の仮実装や共通型のコピーは作らない。

契約が変動中の段階で、本体を必須依存にした API 起動変更や DB migration は行わない。Eumenes 側だけで先行して作れるのは、この対応付けとテスト用データの準備まで。

### E1 — 公開パッケージとアダプター

本体の M0 verify / consumer テスト成功後、検証済み `.tgz` を取り込む。配置・命名は本体の [配布仕様](../../eumenes_memory/spec/implementation-plan.md#配布物の配置と取り込み) に従う。package version / schemaVersion を利用記録へ結び付ける。本体 source 内部への import はしない。

| 用途 | 配置先（各リポジトリのルート基準） |
|---|---|
| 本体側の生成先 | `eumenes_memory/artifacts/eumenes-memory-<version>.tgz` |
| Eumenes が保管する採用済み配布物 | `eumenes/vendor/eumenes-memory/eumenes-memory-<version>.tgz` |
| 採用版と検証情報 | `eumenes/vendor/eumenes-memory/manifest.json` |

`package.json` の依存は `eumenes-memory` に対する `file:vendor/eumenes-memory/eumenes-memory-<version>.tgz` とする。例示の `<version>` は実装時に実際の版へ置き換える。配布物と manifest、依存設定、`bun.lock` を同じ変更で保存する計画とし、Eumenes だけの checkout から復元可能にする。隣接 checkout や手作業で展開したフォルダーを本接続の必須条件にしない。

取り込み時は配布物の SHA-256、package version、schemaVersion を manifest と照合し、配布物を使った consumer テストと接続の結合試験を実行する。同じ版のファイルは上書きせず、新版へ更新する。検証が失敗した場合は採用版を更新しない。M0/M1 では永続 Memory schema を持たないため、依存・lockfile・manifest・配布物を直前の組へ戻して切り戻せる。M2 以降はデータ migration の互換性も確認する。

これらのパスは配置仕様であり、現時点で `.tgz` や依存設定を作成したわけではない。

conversation と continuity を整合した snapshot として読む。既存 `getSnapshot` を単に生成後に呼ぶだけでは、検査と保存の間の競合を防げない。必要なら domain の公開操作としてトランザクション内 snapshot 読み出しを追加する。複数 domain の内部 SQL を Memory adapter へコピーしない。

### E2 — 回答生成と採用

現行の dialogue handler にある `prepareInTransaction` / `execute` / `settleInTransaction` を接続点の候補とする。実装時に最新コードを確認する。

1. prepare で会話と Continuity の整合した snapshot、ホストが決めた権限・用途を取得する。本体が作る view を、その実行の入力として固定する。
2. `ready` の参照情報を、現在のユーザー入力やホストの指示と区別してモデルに渡す。`blocked / overflow` は理由付きで実行を終え、無断で記憶を落として同じ実行を続けない。`disabled` のみ通常の Memory なし経路を使う。
3. 生成後、採用トランザクション内で最新 snapshot を読み直す。本体の同期的な再検証と queue の attempt / lease / cancellation 検証を通す。
4. 回答保存と利用記録を同じトランザクションで確定する。保存結果が未確認なら成功を返さない。
5. source / state / policy が変わっていれば生成物を採用しない。最初は理由付きで終了し、ユーザーによる再実行を可能にする。自動再生成は別途、回数上限と新しい入力の固定を設計して追加する。

再検証後から保存まで変更が割り込まないことが重要。再検証用に別 reader から古い snapshot を取得しない。モデル・ネットワークなどの非同期処理を transaction 内で待たない。

初期の Memory 利用回答は検証成功後に UI/TTS へ公開する。未検証の音声を先に再生してから取消す方式にしない。逐次公開が必要なら、その公開境界と無効化時の停止を検証してから機能を有効化する。

## 4. 結合受入条件

| 条件 | 期待する結果 |
|---|---|
| 通常の確定済みブックマーク | 元発言と版を追跡でき、回答と利用記録を確定できる |
| 生成中の改訂・無効化、原文変更・欠落 | 古い view を使う回答を採用しない |
| principal / scope / policy の変更 | 許可外データを注入・採用しない |
| 古い attempt、取消後のモデル完了 | 回答も利用記録も新たに確定しない |
| 再検証と保存の競合 | 同一トランザクションにより変更の割り込みを防ぐ |
| writer 失敗、保存操作の未適用 | 完了扱いにせず、既存 queue の失敗処理へ渡す |
| Memory OFF | メモリーを注入しない。将来の忘却機能まで停止する設定にしない |
| view の overflow / blocked | 理由が分かり、部分的に切り捨てた成功を返さない |
| 再起動・依存 package の更新 | 古い実行の誤採用を防ぎ、未知の schemaVersion を拒否する |
| 公開・音声 | 未検証の回答が完成回答や音声として流れない |

本体 fixture、Eumenes 結合試験、実モデル・実機器での受入を分けて記録する。日常は repository の domain 別 verify、横断接続では利用側 domain と verify:all を実行する。音声の完了宣言は既存の実機器受入条件に従う。

## 5. 今回の境界

作成・更新したのは計画と配置だけ。本体 M0 は `eumenes_memory` を作業ディレクトリとして実装する。Eumenes の接続は M0 完了後に別範囲として進める。この二つを Sonnet に一括で全実装させず、M0 の成果を確認してから E1/E2 へ進む。
