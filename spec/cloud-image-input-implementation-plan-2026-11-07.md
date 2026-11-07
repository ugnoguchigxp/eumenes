# クラウドLLMの画像入力 調査と実装計画

作成日: 2026-11-07。状態: **実装・対象固定試験・Codexの稼働Web画像live受入完了**。能力を公開しない接続と全体gateには残課題がある（§10・§11の検証記録参照）。初回は調査と計画書作成のみ。同日、利用者の「では実装開始してください」を受け、§6の推奨案D1〜D3に沿って着手した。後続の明示許可を受けて稼働API・Webを再起動した。保存設定・依存を変更する操作とDBを直接開く手動操作は行っていない。

調査対象は進行中の未コミット差分を含む作業ツリー。初回調査の書込みは本書と索引1行のみ。他の作業の差分を維持し、実装・検証は§10に追記する。

## 1. 結論

利用者の推測はおおむね正しい。画像の保存とLARMへの送信は実装されているが、クラウド経路は画像を明示的に拒否している。現在の保存設定を認証付きAPIで読むと、会話は `cloud-only`、選択資源はLuna、接続種別は **`codex-sdk`** だった。したがって、OpenAI互換HTTPの送信だけを直しても、現在の会話先では使えるようにならない。

最初に既存のCodex接続へ画像partsを渡す。次にOpenAI互換HTTP、Claude Agent SDKへ同じ内部画像入力を接続する。添付保存・認可・取消・推論台帳・会話の処理は再利用し、画像内容を説明する別LLMや画像専用のツールチェーンを追加しない。

調査時点では、実現可能な送信形式を公式仕様とインストール済みの型で確認するまでとし、モデルへのlive要求は送らなかった。後続の実装と許可後のlive受入は§10・§11に記録する。

## 2. 目的と範囲

チャットに添付した静止画を、選択中の画像対応クラウドLLM自身が読んで回答できるようにする。本文付き、画像のみ、複数画像を対象とする。物体認識画面の「会話に追加」や撮影依頼も、既存の会話添付へ到達した後は同じ経路を使う。

主な変更対象は `inference` の能力確認・送信adapter、添付欄の対応可否と保持説明、必要最小限の画像形式変換、関連試験と説明書。`conversation` の所有者検査、添付と発言の原子的保存、requestId、撤回、`dialogue` の資料snapshotと回答採用検査を維持する。

次は対象外とする。

- YOLO等の検出器、OCR、動画認識、常時カメラ観測、画像生成APIの変更。
- 文字から画像の用途を分類する処理、モデル名による画像対応判定、別モデルへの新しい自動転送。
- 全サブエージェントへの画像展開、画像の長期記憶化、Agencyの独立した背景呼出しへの画像配信。
- 既存のRouterの意味判断・優先順位・会話ハーネスの変更。
- 本番設定の自動切替、サーバー操作、外部チャットへの依頼。

§6の推奨案で実装する。新しい依存、設定の保存項目、DB migrationが必要になった場合は、その根拠と差分を先に追記する。

## 3. 着手前の調査結果

### 3.1 画像が通る経路と止まる箇所

| 層 | 確認できた現状 | 意味 |
| --- | --- | --- |
| 保存 | [attachments.ts](../api/domains/conversation/service/attachments.ts)、[normalize-image.ts](../api/domains/conversation/service/normalize-image.ts)で原本・正規化画像・PNG previewを保存。JPEGの向き補正・白背景合成・BMPのデコードを実施 | 画像保存を作り直す必要はない |
| 会話から推論へ | [attachment-context.ts](../api/domains/dialogue/service/attachment-context.ts)が実行時にbytesを解決し、`ChatMessage.images`へ付ける。[routed-turn.ts](../api/domains/dialogue/service/routed-turn.ts)の発話呼出しへ渡る | 主会話LLMへ画像を渡す入口はある |
| LARM | [chat-request.ts](../api/domains/larm/service/chat-request.ts)が本文と画像を `content` 配列へ変換。[chat-input.ts](../api/domains/larm/service/chat-input.ts)が `llm.vision`、claim、上限、同じ要求の正式計数を検査 | LARM画像入力は実装済み。今回の固定試験も成功 |
| クラウド共通 | [cloud.ts](../api/domains/inference/service/cloud.ts)の `fitMessages` と `agentRequest` が、`images`が1枚でもあると `image_not_supported` | 画像対応モデルでも、Providerを呼ぶ前に失敗する |
| OpenAI互換HTTP | `cloudRequest` は内部 `messages` をそのままJSONへ入れる | 拒否を外すだけでは `images` が残り、正しい `image_url` partsにはならない |
| Codex | [cloud-agent-shared.ts](../api/domains/inference/adapters/cloud-agent-shared.ts)の `promptParts` は本文中心に会話を文字列化。[codex-app-server.ts](../api/domains/inference/adapters/codex-app-server.ts)の `turn/start.input` はtext 1件だけ | 共通拒否の解除と、ネイティブ画像入力への接続の両方が必要 |
| Claude Agent SDK | [cloud-agent-claude.ts](../api/domains/inference/adapters/cloud-agent-claude.ts)は本文promptを渡す。[claude-session.ts](../api/domains/inference/adapters/claude-session.ts)の履歴型もtextのみ | 現在の文字列promptでは画像を送れない。sessionの写しも点検が必要 |
| 能力情報 | [settings契約](../api/domains/settings/contracts/index.ts)のクラウド資源はmodel・文脈長等を持つが、画像対応・画像上限・保持契約は持たない。[connection-models.ts](../api/domains/inference/service/connection-models.ts)はCodexのmodel一覧を取得しない | 接続種別やモデル名だけで対応を推測してはいけない |
| 画面 | [useChatAttachments.ts](../web/src/workspace/useChatAttachments.ts)は添付時に `connectLarm()` を呼び、`status.larm.chatInput`を検査。[ChatImageInput.tsx](../web/src/workspace/ChatImageInput.tsx)の保持説明もLARM専用 | クラウドだけで使う場合にもLARMを要求する。LARM readyでも会話先の対応は保証されない |
| エラー説明 | [errorMessages.ts](../web/src/errorMessages.ts)は画像未対応時に「画像入力対応のLARMモデル」を案内 | クラウド対応後は送信先に依存しない説明が必要 |

`InferencePort.status()`も現在はLARMのstatusを返している。既存の `/api/status` をクラウド状態へ読み替えると、LARM監視の意味が変わるため避ける。

### 3.2 後続の質問と旧資料の不一致

[チャット画像入力の説明](../docs/chat-images.md)と[2026-10-13の作業記録](.archived/chat-image-attachments-work-record-2026-10-13.md)には、最近の会話内の画像を毎回再送するとある。旧記録では実LARMで3形式・後続質問を確認している。

一方、現行の [generation-prepare.ts](../api/domains/dialogue/service/generation-prepare.ts) の `pendingInput` は、未処理発言のうち最後に添付がある1発言を採用する。[現行結合試験](../api/application/toolchain/chat-image-attachments.test.ts)も、初回は3画像、後続質問は画像0枚を期待している。未処理発言が複数ある場合も、すべての添付を結合する動作ではない。

したがって「LARM側は今も全場面で完成している」とは扱えない。**現在画像のクラウド送信不足**と、**過去・複数発言の画像をどこまで会話へ戻すか**は別の問題である。後者を今回の修正で黙って旧仕様へ戻さず、§6 D3として扱う。

### 3.3 再現と確認した範囲

- 既存のログ閲覧で直近の警告・エラーから確認を開始。表示された直近の警告群には、今回の画像送信失敗を一意に結び付けるrunIdがなかったため、利用者の失敗履歴を断定しなかった。
- 稼働backendの `GET /api/settings` と `GET /api/status` を既存の認証経路で読み取った。設定revision 169時点では、会話はLunaを選んだ `codex-sdk` のcloud-only。LARM自体はreadyでchatInputも存在。この2つは独立している。設定や秘密のdumpは本書へ保存していない。
- 非機密の合成PNGを `cloudRequest`へ渡す隔離診断で、`openai-compatible`・`codex-sdk`・`claude-agent-sdk`の全てが `image_not_supported`。各方式でHTTP呼出し0件、agent呼出し0件だった。実クラウドのエラーではなく、Eumenes内の拒否と確認した。
- 現行3ファイルを `./`付きで明示した固定試験は **38 pass / 0 fail、245 assertions**。所要4.49秒。LARM画像parts・計数・取消・再claim、会話添付、既存クラウドagentの文字入力を確認した。
- 最初の試験指定はBunの部分一致で保存済み検証コピーまで拾い、30ファイル・374件中1失敗と1 errorを含んだ。現行3ファイルに限定して再実行し、上記38件を本調査の基準とした。コピー側の結果を現行コードの故障や成功として数えていない。
- `codex-cli 0.162.1` のオフライン `app-server generate-ts` で、`UserInput`に `image`・`localImage`、`Model`に `inputModalities`があることを確認した。schema生成は一時ディレクトリで行い、削除済み。app-serverの待受けや会話は開始していない。

部分試験の再現コマンド:

```sh
bun test ./api/domains/larm/test/chat-input.test.ts ./api/application/toolchain/chat-image-attachments.test.ts ./api/domains/inference/test/cloud-agents.test.ts
```

今回は文書作成と基準確認のため、domain gate・全体gate・ブラウザE2E・実モデル推論は実行していない。実装後の検証は§8に定める。保存済み検証コピーを拾う指定では再試行しない。

## 4. 外部仕様から分かる実現方法

### 4.1 Codex経由 — 現在の会話先

公式の [Codex App Server](https://learn.chatgpt.com/docs/app-server#turns) では、`turn/start.input`にtextとimageを渡せる。[model/list](https://learn.chatgpt.com/docs/app-server#list-models-modellist)は各モデルの `inputModalities`を返す。利用可能モデルはアカウントに依存する。

既存の一時thread、system指示、tools、outputSchema、stream、取消の経路を維持し、文字promptの後ろへネイティブimage itemを追加する。本文中にBase64を書くだけの方法や、無効にしている `view_image` toolの有効化は使わない。

画像はbackendが取得済みのbytesから作ったdata URLを第一候補とする。インストール版の型はURL文字列を受けるが、data URLと選択モデルの組合せはP0とliveで確認する。外部からEumenesの認証付き画像URLへアクセスさせない。data URLを採用できなければ、その失敗根拠を記録したうえで、既存の一時ディレクトリ内の `localImage`を代案とする。その場合は成功・失敗・取消後の削除も受入条件に加える。

本文に複数発言をJSONで含めるときも、画像の並びと元発言の対応が分かるラベルをhostが添える。対応付けは有限の添付順から作り、画像の意味はLLMが読む。

### 4.2 OpenAI互換HTTP

[OpenAI公式の画像入力ガイド](https://developers.openai.com/api/docs/guides/images-vision?api-mode=chat)では、Chat Completionsのuser `content`をtextと `image_url` の配列にし、Base64 data URLを送れる。既存HTTP経路のAPIは維持し、送信messageの変換だけを共通化する。LARM固有のclaim・token計数・生成オプションを、そのままクラウドへ流用しない。

「OpenAI互換」は画像対応の保証ではない。一般の `/models` から必要な能力情報を取得できない接続では、接続先が正式公開する契約を確認するまで対応不明とする。追加の能力設定が必要ならP0で具体化し、合意前に任意の手入力フラグを追加しない。

### 4.3 Claude Agent SDK

[Claude公式のStreaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)は、`AsyncIterable<SDKUserMessage>`へtextとbase64のimage blockを入れる方式を示している。導入済みSDKの `SDKUserMessage.message`もimageを含むcontent blocksを受け取る。

既存の `startGatedQuery`による認証方式の照合を維持し、照合が終わる前には画像をyieldしない。文字入力だけの呼出しは現状を維持する。画像入力のために別のAPI keyや別の課金経路へ切り替えない。

main sessionの履歴をhostから復元する実装はtext専用なので、現在の入力と履歴の両方を点検する。画像を含む再開履歴が必要なら、本文だけのtranscriptに変換せず、blockを保った履歴の取込みを検証する。未確認のまま「SDK sessionに画像が残る」と仮定しない。

### 4.4 形式・計数・保持の違い

OpenAIの[画像要件](https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements)とClaudeの[対応形式](https://platform.claude.com/docs/en/build-with-claude/vision#supported-formats)はJPEG・PNG等を挙げるが、BMPは含まない。EumenesではBMPを受け付けているため、クラウド送信時は正規化済み画素をPNGへ可逆変換する。既存の `bmp-ts`・`sharp`で実現でき、新しい画像ライブラリは不要。変換後の容量・寸法・全要求サイズも再検査する。

LARMの `llama-chat-token-count.v1` とdigest照合はLARM固有契約である。Codexの確認した公開契約には、同じ要求を事前計数して同じdigestを返す操作がない。[Claudeの計数API](https://platform.claude.com/docs/en/build-with-claude/token-counting)は画像も計数できるが、Agent SDK内部の最終要求やsubscription認証と同一とは確認できない。これをLARMと同等の正式計数として扱わない。

クラウドの保存期間・監査・課金経路もLARMのretention値からは分からない。LARMの「最長7日」等をクラウドへ表示しない。必要な説明は送信先の公式契約・アカウント設定に基づき、不明な値は不明として表示する。

## 5. 再利用を優先する実装案

### 5.1 データの流れ

1. 既存の添付受付・正規化・発言への関連付けを使う。
2. `dialogue`が実行時に、現在の添付参照の有効性を検査して `ChatMessage.images`を解決する。
3. `inference`が受付時の設定snapshotと実行時の接続能力を照合する。LARMとクラウドの情報を混同しない。
4. 送信adapterが画像形式と上限を検査し、同じ画像列を各プロトコルのネイティブpartsに変換する。
5. 既存のstream・tool呼出し・receipt・採用検査で結果を返す。取消・撤回・設定変更後の結果は採用しない。

### 5.2 小さく共有するもの

- 本文と順序付き画像からOpenAI互換のmessage partsを作る純粋関数。LARMの `chatRequest`にある変換部分を低層の `api/infrastructure/`へ切り出し、LARMとHTTPクラウドの双方から使う。LARMの要求全体は共有しない。
- 正規化済みBMPからPNGへの変換と、送信後形式のサイズ検査。低層helperに置き、inferenceがconversationの内部実装やDBを参照しない。必要以上の変換・縮小・圧縮率変更は行わない。
- 既存の `ChatImage`型を使い続ける。API、queue、設定JSON、通常ログへ画像bytesやBase64を保存する新しい契約を作らない。

CodexとClaudeの画像itemは異なるため、それぞれのadapterで接続する。この専用部分は外部プロトコルに必要な変換だけであり、画像の意味判断を行わない。

### 5.3 選択中の経路の能力を画面へ返す

`inference`に選択中の会話経路の画像入力情報を返す公開操作を追加し、同じ情報をbackendの送信検査とWebで使う。既存 `/api/status.larm`は維持する。専用の読取APIを追加する案とし、client契約も更新する。

返す情報は、設定revision・接続/資源の識別、対応可否（対応・未対応・不明・確認失敗）、確認元、対応形式・上限、計数方式、保持説明に必要な公開情報。credential、Providerの生応答、画像bytesは返さない。新しい汎用registryは作らず、既存の接続種別のadapterと `ConnectionModelsService`を拡張する。

- Codexは同じ接続条件で `model/list`を取得し、保存済み資源に一致するmodelのmodalitiesを使う。schemaに項目があることだけで対応としない。情報のない旧版・不明なモデルは、画像対応を仮定せず不明とする。
- Claudeは既存のモデル一覧と導入版SDKの対応情報を利用する。能力を取得できない接続では対応不明を維持し、モデル名の部分一致や「Claudeなら全部対応」という判定を追加しない。
- OpenAI互換HTTPは接続先が正式に提供する能力契約を利用する。契約がない場合の設定追加はP0で具体化する。
- キャッシュは既存の短期cacheを利用し、接続epoch・認証方式・接続先・資源model・設定revisionの変更で古い確認を使わない。送信直前も実行先を照合する。
- `cloud-only`の添付確認ではLARM接続を作らない。`larm-preferred`では主経路と、既に許可された代替経路の可否を別々に示す。UIで対応済みでもbackendが再検査する。

## 6. 実装前に合意する設計項目

利用者の実装依頼を受け、以下の**推奨案で着手**する。外部契約が確認できない接続の有効化や、D3の自動履歴再送への拡張は含めない。

| 項目 | 推奨案 | 選択による違い |
| --- | --- | --- |
| D1 対応順と一次受入 | 現在選択中のCodex経由を先行し、その後にOpenAI互換HTTP、Claude Agent SDKを対応させる。各方式の完了を別に記録 | 一方式の成功を全クラウド対応完了としない。能力・上限契約が確認できない接続は有効化しない |
| D2 クラウドの予算検査 | LARMは現状の正式計数を維持。クラウドは画像形式・件数・転送容量・出力予約をhostで検査し、画像tokenを含む最終的な受付可否はProviderへ委ねる方式を提案する | LARM同等の事前計数を必須にする場合は、同等APIのないCodexは有効化できず、上流契約の追加待ちになる |
| D3 過去・連続発言の画像 | 先行対応では現行の「未処理発言の最後の添付」を維持し、後続で実画像を読むにはファイル選択などで同じ画像を再添付する。説明書を実態へ合わせる | 最近の画像の自動再送や複数未処理発言の全添付を求める場合は、画像を戻す範囲・予算・再構成・取消を別途設計し、本計画へ追加してから実装する |

D2を採る場合の条件:

- `estimateMessageTokens`の画像1枚1,600tokenは会話予算の概算であり、Providerの実測・上限保証・課金値ではない。モデル名ごとの推定式や辞書を追加しない。
- 画像付き要求は組み立て済み文脈を固定して送る。`fitMessages`の古い履歴を削る処理をそのまま適用せず、画像だけ、または画像が付いた発言を黙って落とさない。現在の画像を必ず含む。
- 明白なhost上限超過は送らず、Providerの文脈超過・画像拒否は分類して失敗を返す。画像を外す、別モデルへ移す、未確認の縮小や再送で成功に変える処理は加えない。
- Codex/SDKが要求を自動圧縮・画像省略する可能性はP0で確認する。必要な入力を維持できる設定・契約が確認できない場合、その方式を受入済みとしない。
- 接続先ごとの要求上限を、P0で出典・確認版付きの表へ確定する。LARMの要求4 MiBをクラウドの外部仕様として流用しない。Eumenesの受付上限（1枚3 MiB・8枚等）も緩めない。

既存のfallback許可・時間配分・未公表の失敗に対する規則は維持する。従来許可された代替を実行するときも画像全体を同じ順序で渡し、代替先が未対応・不明なら止める。`image_not_supported`を新たなfallback起点にはしない。生成POSTの結果不明時やstream公表後の自動再実行は追加しない。

## 7. 実装段階と依存関係

| 段階 | 必要作業 | 完了条件 |
| --- | --- | --- |
| P0 外部契約の確定 | D1〜D3の合意。導入CLI/SDK版、選択資源のmodalities、送信形式、画像/要求上限、計数・自動圧縮・保持・エラーの契約を確認。未知値と実測を分けて記録 | 接続ごとの能力と制約が表で確定。不明な方式は後続を止め、モデル名による推測で埋めない |
| P1 内部検査・能力API | 送信直前の能力検査、公開読取操作とclient、共有parts変換、BMPのPNG化、画像付き固定文脈の検査を追加。既存の無条件拒否は、対応確認済み方式の検査へ置き換える | 対応・未対応・不明が区別され、未対応は通信0件。純粋変換と既存LARMの試験が成功 |
| P2 Codex送信 | `promptParts`の文字と画像の受け渡しを分け、既存 `turn/start`へimage itemを追加。添付順・元発言の対応、system/outputSchema/tools、streamと取消を保持 | モックtransportで実際の `turn/start`に画像があり、本文JSON内にBase64が紛れない。新しいツール権限不要 |
| P3 画面と会話結合 | 添付時のLARM固定確認を経路の能力APIへ置換。送信先・保持説明・対応不明・上限・失敗時の下書きを検証。物体認識由来の添付も同じ経路へ接続 | cloud-onlyでLARMへの接続呼出し0件。APIから画像がCodex transportへ届く。先行範囲を説明書と索引へ反映 |
| P4 他のクラウド送信 | OpenAI互換HTTPのcontent parts変換。Claudeのgated streaming input、main/subagent/auxiliaryの入力と必要な履歴の整合を検証 | 各adapterで実画像の形式・順序が一致。認証確認前に画像が出ず、session再利用で画像が消えない |
| P5 受入と記録 | 部分→結合→選択domain→対象ブラウザ→方式別live。設定切替・取消・撤回・上限も確認。最後に全差分とLLM判断の代替処理を点検 | §8・§9を満たし、各方式の実装/fixture/live/稼働反映を区別して記録 |

P1はP0、P2はP1、P3はP2に依存する。P4は各方式のP0とP1を前提に実施する。Codexの一次受入はP3後に実施できるが、その結果をP4の受入に代用しない。

主な変更予定:

- `api/domains/inference/service/cloud.ts`、`connection-models.ts`、`contracts/`、`controller/`。
- `api/domains/inference/adapters/cloud-agent-shared.ts`、`cloud-agent-codex.ts`、`codex-app-server.ts`、`cloud-agent-claude.ts`、必要に応じて `claude-session.ts`。
- `api/infrastructure/`の純粋な送信parts・形式変換helper、既存LARMの変換呼出し。
- `client/`、`web/src/workspace/useChatAttachments.ts`、`ChatImageInput.tsx`、`web/src/errorMessages.ts`。
- 各domainの試験、`api/application/toolchain/chat-image-attachments.test.ts`等の横断試験、`tests/browser/chat-image-attachments.spec.ts`、`docs/chat-images.md`、`docs/larm.md`。

新しいtoolchainを登録する必要はない。もし専門担当の契約改訂に範囲が広がるなら、既存bundle＋登録adapterの手順に従って別途設計する。

## 8. 検証計画

### 8.1 部分と結合

| 層 | 必須の確認 |
| --- | --- |
| 能力 | 画像対応・文字のみ・項目なし・取得失敗、選択modelが一覧にない、設定/接続epoch変更、確認中の取消。未知を対応にしない |
| 形式と容量 | JPEG/PNG、BMP→PNG、EXIF補正後の向き、白背景、画像順、寸法・画素一致、破損と欠損、変換後容量、Base64膨張込みの最終要求上限 |
| HTTP | 文字だけはstring互換、画像はuser content parts。assistant tool_calls・tool_call_id・tools・JSON Schema・streamが保持される |
| Codex | `turn/start.input`に画像がある。本文と画像の対応、画像のみ、2枚比較、outputSchema、tool選択、stream、取消、古い結果の拒否。`view_image`等を有効にしない |
| Claude | 認証照合前はyield 0件。image sourceが有効。mainの再開、未回答user履歴、subagent、auxiliaryの各入力が対応。文字だけの呼出しも回帰しない |
| 失敗 | 未対応/不明/上限超過で通信0件。Provider拒否、通信断、stream途中の失敗で画像抜き再送や別経路への新規転送をしない |
| 会話/API | upload→run受付→解決→選択adapter→回答保存。画像のみ、複数画像、同一requestId、別所有者/別会話、撤回、設定変更、取消後の応答不採用 |
| 画面 | paste/drop/選択、カメラ由来の保存済み添付、解除と拡大、保持説明、対応不明、失敗時の本文/添付保持。cloud-onlyでLARM不要 |
| 後続入力 | D3の合意どおりに画像の有無をtransportで検査。現行範囲なら再添付で画像が届くことを確認し、画像なしの後続を再認識成功と数えない |

新規試験名は実装時に確定する。再現例だけを通す固定応答ではなく、MIME・枚数・順序・接続種別が変わっても成立する契約を検査する。既存の期待値を緩めて成功させない。

### 8.2 gateとブラウザ

実装後、所有domainと利用側を明示して実行する。

```sh
bun run verify -- --domain inference --domain larm --domain conversation --domain dialogue --domain settings
bun run build:web
bun run verify:all
```

`api/application`の会話・Agency・画像添付の結合試験も、変更の影響に合わせて現行ファイルを明示する。共有partsだけの変更でも、LARMの計数に送ったJSONと生成JSONの同一性を必ず確認する。全体gateの既存差分による違反は、今回の違反と分けて記録する。

ブラウザは次の対象ファイルを個別に実行し、cloud-only fixtureを追加する。

```sh
bunx playwright test tests/browser/chat-image-attachments.spec.ts
```

ブラウザfixtureやgateのためにサーバーの起動・停止・再起動が必要なら、操作を具体化して事前に許可を得る。画面なしの検証は消音する。稼働サーバーを無断で操作しない。

### 8.3 方式別liveと実画面

保存済み設定とbackendの公開操作を使い、非機密の合成画像で確認する。製品DBのコピーや別接続先の要求、モデル名固定のスクリプトを作らない。設定は試験用環境へAPIで保存し、実行資源はその保存値とruntime catalogから決める。

各方式で、単画像の色と形、本文なし、複数画像の相違、画像内の小さな文字、BMP由来のPNG、再添付後の参照を確認する。答えを本文や検出メタ情報へ入れず、実画像がないと答えられない設問にする。カメラ等のメタ情報がなくてもLLMが答えられることを確認する。

requestId/runId/attemptId、接続種別、公開model/revision、画像数・容量、HTTP/transport結果、所要時間、返されたusageを検証用の限定記録へ残す。画像・本文・credential・Provider生応答を通常ログへ流さない。費用を伴うliveは、開始前に今回の作業用の予算・件数を確定する。他の作業の予算や許可を流用しない。

稼働Webで添付から実回答まで確認して、稼働反映の受入とする。fixture成功、外部プロトコルの型の存在、過去のLARM実績をこの受入の代用にしない。

## 9. 完了条件と残作業

実装・固定試験・実モデル受入を分けて追跡する。

- [x] D1〜D3の推奨案に沿う実装開始。方式別契約の確認範囲は§10。
- [x] 既存の添付がCodexのネイティブ画像入力へ到達することを固定試験で確認し、保存済み選択の画像能力を実アカウントの一覧で確認する。
- [x] OpenAI互換HTTPとClaude Agent SDKの画像入力・既存の文字入力を固定試験で確認する。実接続の能力契約による保留は§10に記録する。
- [x] UIが選択経路に基づいて可否と保持説明を示し、クラウドだけの利用でLARMを要求しない。
- [x] 画像の省略・意味の固定分類・モデル名分岐・新しい自動fallbackを増やさない。
- [x] 部分・結合・domain gate・対象ブラウザ・方式別live・稼働Webの実施状況と結果を分けて保存する。
- [x] `docs/chat-images.md`の履歴再送説明を合意したD3と一致させ、他の進行中差分を含めて最後の差分点検を行う。
- [x] 後続の明示許可を受け、保存済みCodex経路の実画像によるlive推論と、稼働Webの添付から実回答・再読込までを受入する（§11）。
- [ ] 画像能力を公開しない他の接続は、正式な能力契約の確認後に有効化・方式別live受入を行う。
- [ ] 既存課題の解消後に全体gateを通す。今回の対象試験成功とは区別する。

選択資源が画像能力を公開しない、契約上必要な入力を送れない、または同じ失敗に新しい根拠がなくなった場合は、当該方式の実装・再試行を止める。確認済みの差分と不足契約を示し、無関係なRouterや画像検出器の改修へ広げない。

## 10. 実装と受入の記録

2026-11-07、既存の添付保存・推論を再利用して実装した。新しいモデル名分岐、画像内容の分類、専用LLM、設定フラグ、DB migration、依存追加はない。

- Codexの `inputModalities`を発見し、画像送信時は実行用の同じ一時接続でも再検査する。`turn/start`へimage itemを送り、本文には添付順だけを示す。要求の圧縮・モデル転送を観測した場合は回答を採用しない。
- Codexのstdio接続・取消・出力上限・権限隔離を共有し、一覧の取得と生成の双方で使う。native toolは有効にしない。
- 大きな画像がapp-serverの入力確認通知で返る場合は、送信要求のbytesを基準に通知分を別枠で制限する。回答の上限は維持する。2 MiB超のPNGで従来上限との衝突を再現し、修正後の正常送信と過大回答の拒否を固定試験で確認した。
- OpenAI互換HTTPの画像parts、Claudeの認証確認後のimage blocks、BMPからPNGへの可逆変換を実装。文字入力とLARMの正式計数は維持する。
- クラウドの画像付き要求は文脈を固定する。8枚・1枚3 MiB・16 MP等の受付制限を維持。hostから送る入力の直列化上限は32 MiB（既存8画像×3 MiBのBase64量）とする。Claudeは公式仕様に合わせ各辺8,000px以下。画像tokenの最終的な受付可否はProviderが判断する。
- `/api/inference/image-input`は主経路と許可済み代替の可否を分けて返す。添付欄はcloud-onlyでLARMを接続せず、設定revision変更前の応答を採用しない。保持説明も経路別にする。
- 自動履歴再送は追加しない。Claudeのtext専用再開履歴へ画像が混じる場合は、黙って落とさず失敗させる。初回計画の「履歴から再添付」という記述は訂正した。履歴画像を下書きへ戻すUIは現行にはなく、通常のファイル添付を使って再送する。

**能力契約による保留:** ClaudeのAPI-key接続は公式Models APIの `capabilities.image_input.supported`を使う。現行Claude SDKのsubscription一覧には画像能力がなく、一般のOpenAI互換HTTPにも統一の能力項目はない。この2経路は送信変換のfixtureを確認しても、実行時には対応不明で止める。正式な能力契約を得てから接続する。

**固定試験時点の受入状況:** 固定モデルの会話受付→画像解決→クラウド送信→回答保存、Codexのネイティブ入力、Claudeの認証ゲート、画面の取消と経路切替を確認した。利用者の許可後、ブラウザー4ケースと、実アカウントの一覧にあるLunaの画像対応（text・image）も確認。ブラウザーで検出したサーバー用モジュールの混入は、契約entryだけを使う参照へ修正した。この時点ではlive画像認識・稼働反映は未実施。後続の受入は§11と[検証記録](verification/cloud-image-input-2026-11-07/README.md)を参照。

## 11. 稼働反映とlive画像受入

2026-11-07、利用者から稼働環境への反映、Lunaへの実画像送信、必要なサーバー再起動の明示許可を得た。保存済みの接続・モデル・経路を維持し、稼働中のAPIとWebを通常の起動手順で再起動する。

完了条件は、再起動後のAPI健全性と画像能力、稼働Webでの実ファイル添付・送信、実モデルが画像内の形・色・配置等を正しく読み取った回答、採用された推論経路と画像添付の保存、再読込後の表示を確認すること。認識の答えは送信文やファイル名に含めない。検証ブラウザーは消音する。試験結果は固定試験と分けて記録する。

能力不明の経路の有効化、設定の書換え、依存追加、無関係な設計変更は行わない。失敗時はrunIdと許可された診断情報から原因を確認し、既存設計を満たす修正の範囲で対応する。

**結果: 完了。** 稼働API・Webを再起動し、設定revision 170を維持した。稼働WebからPNGを1枚添付し、Lunaが赤い円3個・青い正方形2個・緑の三角形1個、その配置、英数字「R7K4」を正しく回答した。実行記録の `source=cloud`・`billingPath=codex`・`status=succeeded`・`accepted=1` と保存済み選択モデルの一致を確認した。runIdは `313780cb-414b-4393-a4e1-8f19ba5b0199`。再読込後の画像・回答表示も成功し、検証ブラウザーは終了、稼働サーバーは継続している。[live証拠](verification/cloud-image-input-2026-11-07/live-summary.json)を保存した。起動時の一時的な失敗と既存gate課題は[検証記録](verification/cloud-image-input-2026-11-07/README.md)に分けて記載した。
