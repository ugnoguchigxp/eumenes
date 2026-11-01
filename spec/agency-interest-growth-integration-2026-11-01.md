# 改善F＋③の本体接続

利用者の「このままEumenes本体へのtarball配置と、必要な改修、設定」に基づく実施計画。先に承認されたFの状態モデルとホスト所有SystemContextを使用する。

## 範囲・依存順・完了条件

1. AgencyのFをホスト接続で使用できるようにする。現在B1に限定されている話題・TODO・発話感情の入力接続をFにも適用する。Fの発話には既存通り候補のIDとrevisionが必要で、候補をコードで生成しない。
2. 改善Fの関心と問いの区別、状態変更、取得済み結果の利用、正しいwire出力と、③の完成した発話本文の指示をEumenesの既存context資産へ反映する。①②④・融合版は導入しない。
3. Fのupdateは問いと候補の両方を返すため、既存の呼出回数・間隔を維持したままupdateの出力上限を2400、selectを1000にする（採用サンプルの測定値）。ホストの出力上限もupdateが通る値に揃える。モデル・経路・認証は保存済みの設定を使う。
4. TODOからの確認質問は、既存の仕事変更通知をsource.changedの事実観測に接続し、通常のF updateに候補を判断させる。意味理解・候補選択・関心形成はLLMが行う。完了通知は引き続き既存の別経路が担当する。
5. Agencyの全体検証・pack検査を経た確定コミットのtarballとchecksum・manifestをvendorへ配置し、依存とlockを更新する。Eumenesの部分・結合・全体gateを実施し、差分と残作業を記録する。

新しいtoolchain、外部操作権限、DBスキーマ、状態の永続化方式、モデル名の固定、判断用の語句分岐は追加しない。既存のRAM単位の会話runtime、取消・配信直前の世代検査、前景優先、idle設定、未回答上限を再利用する。自発的なツール実行は本体で公開されていないため、tools=[]を維持する。

サーバーの起動・停止・再起動は明示許可が必要。配置・固定検証を先に完了し、稼働プロセスへの反映を別に確認する。実モデル・実機器の確認を固定試験成功と同一視しない。

## 変更前の証拠

- 本体はmain、未コミット差分なし。旧配布物は0.1.1/94ad302a4ca7。
- `./api/application/agency` と `./api/application/vendor.test.ts`: 78成功・失敗0。
- AgencyのFではhostTopics/hostTodos/standingInterests/utteranceEmotionが無効となることを実コードで確認。接続だけの変更で既存の話題・質問・感情を失わないための対応が必要。

## 検証方針

部分はFのホストデータ提示、候補必須・不正参照拒否・感情付与・関心の独立根拠を確認する。結合は実assembleAgency→Agency runtime→LlmPort→既存inferenceの固定提供元を通し、関心形成と実際の発話・TODO質問・取消を検証する。全体はAgency verify、Eumenesのdialogue/inference/settingsと横断verify:all、context:check・型・vendor整合を確認する。担当外の既存失敗は切り分けて報告し、期待値を弱めて通さない。

## 配置・設定した内容

- `vendor/agency/eumenes-agency-0.1.2-c0b649d3a4e4.tgz` を配置。確定ソースは `c0b649d3a4e4501a40fadee20de860d8d958476e`、dirty=false。SHA256は `518a8e91ee736876be22637781af0ada0adc1e6463182ab2fbb1f531c3a1ab88`。packの内容・公開API・利用側の型検査を通過。旧配布物を置換し、package.json、bun.lock、checksum、manifest、インストール済み版とルール版の一致を検証した。他の依存更新やインストールスクリプト実行はしていない。
- `api/application/agency/runtime.ts` でF + interestFormationを選択。既存の組立てをhost.tsから切り出し、ファイルサイズ規則も維持した。ホスト所有の指示、話題・TODO・人格の関心・感情を接続した。人格の関心IDは自律形成した関心のIDと分離する。
- 背景updateは2400 token、selectは1000 token。既存の呼出上限12回/10分、間隔30秒と、保存済みのidle/未回答上限・人格・モデル経路を使う。構造化background controlの上限だけ2400へ調整し、非構造化の従来上限1500を維持した。DB設定項目の追加や保存済み値の上書きは不要。
- context資産のupdate/selectを改善F＋③へ更新し、s11tnextの生成物も更新した。取得済み情報と未解決の問いを区別し、候補から利用者へ実際に話す本文を生成する。①②④と融合版は組み込まない。
- 比較実験で発生したFのprovider grammar rejectionを避けるため、既存mapJsonSchemaを使って同じnullable schemaを$defsへ共有した。送信表現だけの変更で、元のZod schemaによる受信検証は維持した。定義を展開すると元schemaと一致し、const等のデータや既存定義が変わらないことを試験した。
- TODOの新しい確認質問をsource.changedとして記録し、既存updateに候補の要否を判断させる。質問の重複通知、取消済み・古い世代の配信、前景優先、完了通知の別経路は既存機構を維持した。

## 最終の固定検証

- Agency: 全体verify 761成功、失敗0（2 skip、1 todo）。新しいFホスト入力・感情と、候補必須/観測根拠検証を含む。mainへpush済み。
- 本体のAgency・vendor・背景controlの部分/結合試験: 88成功、失敗0。既存ホスト試験の固定モデルをFのintent/candidate出力へ更新した。忘却後に候補がないFではLLMを呼ばないこと、TODO変更はupdateを経て候補化することを明示して確認した。
- `bun run verify -- --domain dialogue --domain inference --domain settings`: 成功。backend 834成功、Web 32成功。全体の型、整形、lint、境界、SQL、SystemContext、サイズ検査とDesignSystem buildも成功。記録: `verification-reports/runs/2026-11-01T09-01-16-404Z-ab9487a6-9129-493b-8672-cd9570e90cf6/report.json`。
- `bun run verify:all`: domain-docsで停止。今回未変更のdocs/domains.mdの生成表とscripts/domains.tsの不一致が原因。両ファイルとdomainの入口には差分がなく、本タスクが生成表を変更したものではない。担当外の文書は修正せず、全体gateが成功したとは報告しない。記録: `verification-reports/runs/2026-11-01T09-00-11-038Z-74083656-71ce-44ac-8a57-8a1d921b547a/report.json`。
- 最終差分を確認し、利用者の語句・個別題材による分岐や、LLMの意味判断を置き換える処理は追加していない。

## 稼働反映と残る確認

配置・改修・固定検証は完了。現在のローカルAPI（既定127.0.0.1:8787）に接続できず、待受プロセスも確認できなかった。AGENTS.mdの明示許可規則に従って、製品サーバーの起動・停止・再起動はしていない。

本体の起動許可後、既存設定で起動し、API経由で保存済みの設定と起動状態を確認する。実モデルの振舞い、実際のクラウドAPIによるF schema受理、音声実機は今回の固定検証の対象外。新しい実モデル比較は実行せず、追加API費用は発生させていない。

会話ごとの関心状態は既存ホストと同じRAM管理であり、再起動をまたぐ保存や自発的な外部調査ツールの新設は本接続に含めていない。
