# WorldModel最新版の導入と接続検証（2026年11月7日）

ユーザーの依頼により、WorldModel main `64033aa7618105d1c8ca7ddba831d21e9c0c1f9a` を固定配布物としてEumenesへ導入する。既存の単一Writer、Memory依存登録、Stewardの抽出・採用、照会、初期同期、忘却・復元経路を再利用する。意味判断やモデル選択方式は変更しない。

## 範囲と完了条件

1. 既存の他作業差分を保持し、導入前の依存宣言・lock・manifestとソースhashを `verification-reports/world-package-adoption-2026-11-07/` に記録する。
2. 更新前のWorld結合試験を確認し、最新版の配布manifestから契約版・migration・export差分を照合する。
3. 内容hash付きWorld tgzとchecksum、manifest、依存宣言・lockを更新する。旧tgzと既存Memory runtimeを維持する。
4. 必要な互換修正は既存adapterの契約検証・接続に限定する。部分試験、World結合、利用側を含む領域verifyの順で検証する。検証期待値を弱めない。
5. 他作業の更新による結果無効化を避けるため、最終verifyは製品data・設定・秘密を含まない固定ソースコピーで実施する。導入版・結果・差分点検・残件を本書へ記録する。

製品DB・設定・秘密のコピーや変更、稼働サーバーの起動・停止・再起動、24時間運用、commit/pushは含めない。実モデル品質の正式受入とfixtureの接続検証を区別する。

## 状態

導入、既存経路との互換確認、部分・結合・利用側verify、稼働APIの読み取り専用確認、差分点検を完了した。製品データを使う新規書込みや実モデル品質の正式受入は行っていない。

## 互換差分の確認

導入前233件は成功。新版の部分20件は成功したが、結合では227成功・6失敗。原因は実測fixtureが必須の `observedAt` を欠くこと（2つのseedから5件に波及）と、Gapの新しい `freshness` フィールドを旧試験が拒むこと（1件）に絞れた。既存の公開validator/plannerとホスト接続を再利用し、実測fixtureへ明示時刻を与え、登録・採用の拒否をseedが見逃さないようにする。Gapはフィールドの有無だけでなく、観測時刻がない場合の `unknown` を検証する。製品の検証・期待件数・権限は緩めない。

修正後の結合233件は成功。領域verifyは、Bun 1.4.4の整形結果（時刻なしのファイル名と件数）を既存parserが認識せず停止した。既存の領域別検証方針に合わせ、実出力をparserの追加形式として扱う。整形失敗の総件数と認識件数の照合を維持し、領域内は失敗、領域外は警告、認識不足は全体失敗になることを試験する。担当外の2ファイル自体は変更しない。

## 導入結果

- 配布元: WorldModel main `64033aa7618105d1c8ca7ddba831d21e9c0c1f9a`。remote mainとも一致。配布時のsrc未commit変更は0。
- 配布物: `vendor/world/eumenes-world-model-0.0.1-2cbdf5a5b960.tgz`。SHA-256 `2cbdf5a5b96053ad4f9ed10ca2bed03b8ca6b60cd034f7cf732e163e8ed63997`、source digest `337b07126dd61299cdd19f77c4cd7dfe85318e7882964fca9f4c312c10a4998b`。
- 契約版・canonical版は各1、migrationは7本すべてid/hash同一。公開値exportは `sourceIdentityKey` の追加のみで削除なし。新規DB migrationやホスト契約変更は不要だった。
- `package.json`、`bun.lock`、checksum、vendor manifest、インストール済みmanifestを照合。インストール前との差はWorld依存のパスとintegrityだけで、Memory/Memory-host/Agency等の既存依存を維持した。旧World tgzも残した。
- 接続は既存のserver組立て、Steward抽出・採用、SourceAdapter、Memory依存登録、照会、初期同期、忘却・restoreを再利用。新writer/queueや意味判断の固定分岐は追加していない。

## 検証結果

| 段階 | 結果 |
|---|---|
| 導入前のWorld結合・vendor | 233 pass / 0 fail / 35 files |
| 新版の抽出・訂正・忘却・初期同期・vendor部分 | 20 pass / 0 fail |
| 互換修正の部分 | 28 pass / 0 fail。実測登録・採用成功とfresh、未観測Gapのunknownも検証 |
| 固定コピーのWorld結合・vendor | 233 pass / 0 fail / 3242 assertions / 35 files |
| 検証基盤の部分・結合 | 18 pass / 0 fail / 110 assertions / 2 files |
| World配布consumer | 7 pass / 0 fail / 671 assertions。単独install、型宣言、SQLite、採用・Slice・receipt・拒否・rollback・忘却・process再起動 |
| 利用側6領域verify | backend 912 pass / 0 fail / 8747 assertions / 149 files、Web 85 pass / 0 fail / 11 files |

領域verifyは `world / memory / steward / conversation / agent-runtime / tool-runtime`。依存/SQL境界、SystemContext、整形・lint、型、DesignSystem buildを含む。最終reportは [fixed-verification/report.json](../verification-reports/world-package-adoption-2026-11-07/fixed-verification/report.json)。入力・終了revisionはともに `e1d457a1e3197eb34203f7a65d7116cd28bf2491e1a5b6d48792680cc0a56c06`、integrityErrorsは空。導入・接続対象10ファイルは作業ツリーとbyte一致を確認した。

忘却の試験には、未settleイベントのcandidate root供給、再流入防止、実ファイル/WAL・単一Writer・実Memory、両journalと古いDBの復元、10境界での実SIGKILLと別processでの再開を含む。これは合成データによるhost結合であり、製品データの忘却実行ではない。

検証基盤の試験を最初に共有ツリーで実行した際は、既存のignored artifacts内の過去ソースコピーまでinventoryが拾い3件失敗した。この結果を成功扱いせず、製品data・設定・秘密・過去出力を含まない固定ソースコピーへ移し、同じ18件を変更なしで通した。最終verifyにも担当外の規模3件、整形2件、lint1件が警告として残る。対象ファイルを除外したり、基準を弱めたりしていない。

## 稼働APIと制約

導入後に起動された既存サーバー（manifest更新22:45:52 JST、観測したprocess開始22:49:22 JST）へ、既存認証の読取関数とGET APIだけで確認した。22:57:01 JST時点で `/api/status` はready、LARMもready、Memoryはenabled/healthy、登録済み `artifact:settings.world@6` の `world-status` はonline。本文・原応答・認証値は保存せず、状態フラグだけを [live-readonly-status.json](../verification-reports/world-package-adoption-2026-11-07/live-readonly-status.json) へ記録した。プロセス内SDKのcommitを直接返すAPIはないため、実行版の同定はインストール済みmanifestと起動時刻による照合であり、直接のversion応答ではない。

こちらからサーバーを起動・停止・再起動していない。製品DB・設定・秘密のコピー/変更、実モデル/API生成、24時間運用、commit/pushは行っていない。他作業の差分は保持。WorldModel側の実モデル・実Runtime台帳・実仕事の正式受入を、この接続成功で完了へ変更しない。

証拠は `verification-reports/world-package-adoption-2026-11-07/`。context_compile / compile_eval は今回各1回。
