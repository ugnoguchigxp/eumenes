# Docling Desk連携の準備記録

日付: 2026-10-25（日本時間）。以下は調査・設計準備時点の履歴。実装後の結果は[受入記録](acceptance.md)を正本とする。

## 目的・範囲・完了条件

認証済みEumenes利用者が追加キー入力なしでDocling Deskを起動し、別タブで文書を取り込み・閲覧できる入口を、新しいデータドリブンのツールチェーンとして追加する。profile・Skill・SystemContext・公開操作・登録adapter・OpenUI・設定・認可・検証を一つの接続として扱う。

依存順は、既存契約・中継調査 → 設計整理 → domainと設定 → bundleと実行adapter → DesignSystem/OpenUI/Web adapter → 部分試験 → 結合試験 → fixtureブラウザ → live API・実ブラウザ → 差分点検。以下の初回調査・画像生成記録は履歴であり、最新の構成は末尾の設計改訂を正本とする。

完了には、利用者が列挙したcold起動、ログイン、upload、Wordプレビュー、PDF OCR、自然停止、復帰と保持、認証・ticket・上限・partial/failedの確認が必要。実装・fixture・live API・実ブラウザの結果を分ける。設計合意前に製品コードや稼働設定を変更しない。

## 開始時の状態

- ブランチはmain。別件の多数の未コミット変更あり。共有のadapter登録、bundle、artifact契約等も変更中。今回の調査では既存差分を変更していない。
- `initial_instructions`を1回実行。関連設計と実装を読んでから`context_compile`を1回実行。
- add-toolchain、system-context-engineer、imagegen、およびプロジェクトのdata-driven-toolchain手順を確認。画像生成は利用者のプロジェクト指定を優先し、built-inやOpenAI CLIでなく既存LARMサービスを使用する。

## 読み取り確認

- settings domainの`readStoredLarm`で保存済みControl接続先を取得。`http://192.168.0.130:9810`、保存済みprofileあり、既存backend資格情報あり。認証付きEumenes `GET /api/settings`も200で同じ接続先。秘密の値を出力・保存していない。
- 保存済みControlへ既存Bearerで`GET /v1/local-services/docling-desk`: 200、state=stopped、generation=4、busy=null、activityFresh=false。定義revision=`feec1222d1748ae46021dda92b668b63a2a384513c7275ff273128bdce571953`。
- 認可済み`ssh gnosis`で指定資料・gateway/login sourceを読んだ。gnosis内部の`GET http://127.0.0.1:28765/health/live`: 200、status=ready、service=docling-gateway。本体の起動要求は行っていない。
- Macの待受一覧ではSSHは127.0.0.1:18790のみ。Doclingの28765に待受なし。既存SSH host設定gnosisは利用可能。新規トンネル・サーバー起動は未実施。
- 稼働中Eumenesのアーティファクトメニュー・タイマー入口を実ブラウザで参照。Docling入口はない。既存画面の濃色・タブ・部品構成を画面案へ反映。画面表示はDocling受入ではない。
- LARM catalogでcapability=`media.image.generate`、protocol=`larm.image-generation.v1`のサービスを発見。URLとdescriptionを確認。画像用サービス選択はcatalogの順序を使い、profile/model名をファイルやコードに固定しない。catalogの他profileに取得エラーはあったが、対象サービスの発見は成功。

## 第1案時点の残作業（構成は後述の改訂で更新）

- 同一portのSSH中継とlocalhostでのSecure Cookie受入を含む設計の合意。
- 入口・domain・設定・bundle・アーティファクト・各試験の実装と実行。
- live ticket発行・実ブラウザログイン・文書取り込み・自然停止/復帰の受入。
- fixture・live API・実ブラウザそれぞれの結果記録。未実施を成功と扱わない。

通常ログへticket、cookie、文書本文、Bearer、Provider生応答を保存しない。gnosisのDB・文書ファイル・秘密設定は読み書きしない。

## 画面案の生成と確認

- 保存済みLARMのcatalogから発見し、接続確保応答の`services[].url`と`description`も確認した。既存`createLarmPlayground`がprofile/revision/capability/protocol/modelを照合し、終了時に自分の接続を解放する。
- 第1案: 1280×900 PNG、966,691 bytes。生成POST一回、結果取得成功。目視で全体構成、起動中、別タブ、共通ライブラリ説明を確認。本文中のDeskの綴り誤りと「使っていない間は停止」の表現を修正対象にした。
- 第2案: 1280×900 PNG、970,003 bytes。生成POST一回、結果取得成功。第1案の再送ではなく、本文を簡潔にし「通信がなくなると自動で停止」とした改訂promptで新規生成した。開始・起動中の二状態、主操作、日本語の可読性、キー入力欄なし、共通ライブラリ・別タブ表示を目視確認した。下部の小さな文字に画像生成由来の乱れが残るため、実装の文言は設計とUI契約を正本とする。完成画面の証拠には使わない。
- 採用候補は`spec/design/docling-desk-2026-10-25/artifact-concept-v2.png`、最終promptは同ディレクトリの`image-prompt-v2.txt`。実行方式は既存LARM API。built-in画像生成やOpenAI API CLIは使っていない。
- 画像生成が成功したことと、Doclingの接続・ログインが成功したことは別。Doclingへの起動POSTは未実行。

## 設計準備の確認と俯瞰評価

- 目的・既存契約・接続制約・UI・指示構成を確認した時点で進め方を評価した。停止や根拠のない同一再試行はない。新しい証拠としてEumenesの60秒HTTP制限とDoclingの5秒pollを得たため、非同期起動と無通信条件を設計へ反映して継続した。
- SystemContextを別の固定文へ重複させず、既存のprofile＋Skill＋tool schema合成を使う。製品用の担当と今回のCodex作業を区別し、別のCodexチャットへの送信やsub-agent起動は行っていない。
- 設計書の参照、登録予定ID、操作境界、認証値の非保存、LLM判断を代替する語句分岐が含まれていないことを点検。行動評価12件を`behavior-evals.json`へ準備した。まだモデル評価を実行していない。
- 製品コードを変更していないため、domain verify・API結合・fixture E2E・Docling live受入は未実行。ドキュメント段階で存在しないdomainの試験を走らせない。画像生成は利用者の明示要求として別に実行した。
- 設計合意、Mac loopback中継の開始と反映・試験に必要なEumenes/隔離サーバー操作の許可が次の着手条件。gnosisのLARM/gateway/systemd再起動は不要。

## 利用者の補足による設計改訂

- 指示: Doclingの既存UIは別タブで閲覧する。Eumenes内での起動待ちの必要性を見直す。
- gatewayの`ready()`と`/auth/ui-tickets`を再確認。ticket発行要求そのものが本体起動・ready待ちを含むため、Eumenesの先行起動確認やpollは不要。停止中のticket発行に通信待ちが残る点は区別する。cold/warm時間は未実測。
- 前案のqueue、永続launch台帳、起動待ち専用ページ、状態GET/URL受取/取消の個別API、ticket保管庫を撤回。専用POST一回でticket URLを取得し、別タブへ直ちに渡す。
- `idleTimeout:60`だけを根拠にqueue必須とした判断を修正。Bun公式の要求単位`server.timeout`を確認し、対象要求だけのtimeout調整を設計へ反映。Honoの`fetch`は第2引数をenvとして受けることと、既存client/transportに短い一律timeout・自動再送がないことをsourceで確認した。実サーバーでの適用検証は未実施。
- アーティファクトは開く入口に限定。通信中はボタンの実行中表示のみ。既存画像第2案の右側の起動待ち専用パネルは撤回し、新しい完成図として再掲しない。
- 変更は設計と作業記録だけ。製品コード、保存設定、中継、稼働サーバーを変更せず、ticket発行・Doclingブラウザ受入も未実施。製品試験を実行しない理由は製品差分がないため。

## 実装・受入と俯瞰評価

- 利用者から別タブ案の実装、中継開始、Eumenes・試験サーバー操作の許可を得て着手した。settings、bundle/adapter、DesignSystem/OpenUI、専用ticket API、fixture、live試験を依存順に実装した。
- 部分試験で型契約の不足とブラウザfixtureのredirect分離不足を確認し、Doclingの担当範囲で修正した。gatewayの一回限りticket契約へ限定し、意味判断の専用処理は追加していない。
- 検証中の並行変更で2回の結果がinvalidatedになったため、進め方を俯瞰し、同じツリーでの再試行を止めて秘密・製品DBを含まない固定コピーへ方針変更した。入力が固定され、最終Docling verifyは成功した。
- 別変更による音楽公開定義の不足を検出した際は担当外を修正せず停止した。公開定義の更新と試験サーバーの起動成功という新しい証拠を得てコピーを一度更新し、利用側Bun712件・Web38件の成功を確認した。
- 実ブラウザの起動、キー不要のログイン、Word/PDF OCR、自然停止、既存Cookieと文書保持まで確認し、残作業を全体gateの担当外問題の記録・差分点検へ縮めた。正常な変換・停止待ちを失敗として再起動しなかった。
- 最終差分では別作業の変更も確認し、そのまま保持した。今回専有する26ファイルは検証コピーと一致。残る全体gateは受入記録へ分離した。context_compileとcompile_evalは累計各3回。
