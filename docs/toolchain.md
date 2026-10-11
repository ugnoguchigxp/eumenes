# 会話からの調査(toolchain)

追加の種類ごとの変更箇所と最小例は[ツールチェーンの登録と拡張](toolchain-extension.md)、確認段階と過去の実績は[検証手順と基準記録](toolchain-extension-verification.md)を参照してください。

通常の会話入力からWeb検索・読取りを選べます。`EUMENES_TOOLCHAIN_ENABLED` は既定 `1`、`0` なら従来の会話生成へ戻ります。会話LLMが現在の調査担当（LARM）またはCodex Lunaを選びます。内部JSONを読み上げや態度収集へ渡しません。子の待機中は推論枠を解放します。

| 会話ツール | package | 担当 | 検索 | 読取り | 保存本文 | モデル呼出し | 報告 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `research` の `web` | `package:web.quick@2` | 現在の担当(LARM) | 1 | 1 | なし | 5 | search報告 |
| `research_web_luna` | `package:web.search@1` | Codex Luna | 1 | 3 | 4 | 12 | search報告 |
| `research` の `history` | `package:history.research@2` | 現在の担当 | — | — | 履歴 | 7 | V3報告 |

天気、一銘柄の株価、Wiki等にまとまった言葉の定義・地名・人物、指定URLの一項目など、一つの事実の確認は `research` の `web` を使います。Lunaが公開されている場合、ニュースや一般的なWeb検索は `research_web_luna` を使います。未公開の場合は名前や利用指示を提示せず、webの短い確認予算で確認できた範囲を返します。Lunaは検索の代替として、見つかった情報と出典を早く返す担当です。短い依頼、分野未指定のニュース、リアルタイム情報も対象です。網羅的な調査を行うエージェントは別設計とします。振り分けは会話の文脈と依頼を持つLLMに任せ、語句辞書や文字数の条件を置きません。

search報告の経路(`web.quick@2`・`web.search@1`)は既存の検索報告処理を使い、quickは簡単な検索の指示、Lunaは検索用の指示を使います。検索抜粋で回答可能ならそこで報告し、本文は必要なときだけ読みます。要件抽出・確認profile・要件別の採点・finish後の意味検証はありません。既存の報告version 2と出典参照検査を再利用し、成功時はfinishから直接会話回答へ進みます。構造や参照が不正な場合の修正(一回まで)、権限・取消・期限の検査は維持します。ニュースは指定件数、指定がなければ重要度順の3〜5トピックを短く要約し、内容の裏取り・逐語照合・採点はしません。情報が少なければ得られた分を返し、抜粋だけの結果はpartialを保持します。各モデル呼出しは独立しているため、有効な根拠の正確な抜粋と実行済みの操作条件を毎回提示します。

実装目標(SystemContextの層構成、会話方針と公開ツールの一致、結果返却の必須規則など)と現行との差分は [Web検索 実装目標](../spec/web-search-target-2026-10-11.md) にあります。今回の会話契約と根拠容量の修正範囲は[実装計画](../spec/web-search-repair-implementation-plan-2026-10-11.md)のA〜Dです。後続の構造改善とは区別します。

Lunaはbackendで `codex exec --model gpt-6-luna` を実行します。backendの実行ユーザーでCodex CLIをインストール・ログインし、PATHから起動できるようにしてください。実行ファイルは `EUMENES_RESEARCH_CODEX_EXECUTABLE` で指定できます（既定 `codex`）。CLIが見つからないときやWeb調査が無効なときはLunaのツールを公開しません。認証・モデル利用権・接続の失敗は調査失敗として扱い、別モデルへ自動変更しません。

各stepは空の一時ディレクトリでephemeral・read-onlyとして実行し、ユーザー設定・exec規則・native検索・shell・JS実行・MCP・apps・追加エージェントを使いません。CLIの保存済み認証だけを再利用し、製品DB・LARM認証・設定を渡しません。stepの固定指示(共通規則・経路方針・TOOLS・OUTPUT_SCHEMA)だけでCLIの基本指示を置き換え、修正依頼などstepごとの通知・依頼データ・取得資料はJSONの入力として渡します。出力schemaはworkerの契約から値として受け取り、指示文から読み戻しません。取消は子processの終了を待たずに失敗として返し、終了の回収は最大1.5秒だけ待ちます。イベント列(256 KiB)と最終応答(64 KiB)の上限は別です。ホストのSKILL・plugin・画像生成・ブラウザ等の不要な機能も無効にします。既存の出力契約を `--output-schema` に渡し、`--output-last-message` の最終応答だけを、イベント列の `turn.completed` とプロセス成功を確認して採用します。一時ファイルは終了・取消時に削除します。途中の説明文を操作として実行しません。Lunaは既存のinvoke/finish契約で操作を選び、Eumenesの検索・本文取得・保存本文・資料guard・根拠参照を使います。担当は子の入力と推論requestへ保存され、step間で変わりません。共通の期限・取消・receipt採用検査を通し、CLIの終了と取消では所有するprocess groupを停止します。Providerの生応答はログへ保存しません。CLIの接続方法は[公式の非対話実行仕様](https://developers.openai.com/codex/noninteractive/)に従います。

子は取得本文を読み、短い要約、主張、出典、未確認点を返します。メインへ本文・生引用・ページタイトルは渡しません。主張の引用が実際に子へ提示した資料に含まれるかを確認しますが、この検査だけで主張の意味まで正しいと保証するものではありません。メインでも報告を未信頼データとして扱います。調査cardに進行状態・停止・出典・確認できなかった点を表示します。

話題や地域を限定せず、検索・本文取得・保存本文の確認を使います。検索語、取得先、資料の解釈はLLMが選びます。天気・株価専用の読取りや、発話の固定文法による取得先学習は実行しません。上流の取得拒否やguard拒否を迂回しません。結果データは14日、本文を含まない処理metadataは30日で整理し、既存の会話は残します。

`EUMENES_LIVE_TOOLCHAIN=1 bun run verify:live -- --domain agent-runtime` は一時DBを持つ隔離backendを起動し、実LARMと公開データで天気・株価を確認します。LARM認証はbackendの環境変数から読み、通常DBは使いません。判定は子の報告と最終回答の数値まで確認します。[実装・検証記録](../spec/verification/toolchain/README.md)を参照してください。

domain の責務は [domains.md](domains.md)、Web 取得は [web-research.md](web-research.md)、保存済みの取得先と手順は [research-routes.md](research-routes.md) を参照してください。

## 要件profileとV3報告

要件profileとV3報告は `history` 経路だけが使います。Web経路(`web.quick@2`・`web.search@1`)はprofileを受けず、指定された場合は開始時に `invalid_requirement_contract` で拒否します。会話ツールもkind別の入力を提示し、profileの選択・解決はhistoryだけに適用します。

利用者が再利用する確認基準は `kind:requirement` のデータとして登録します。要件profileは実行権限を持たず、package検索・ツールの依存閉包へ入りません。会話モデルは提示された短いrefから適用するprofileを選びます。workerは最初の操作と同じ応答で依頼の条件を抽出し、ホストが登録profileと合成して、取得開始前に凍結します。原文、版付きSKILL/profileの本文、選択した要件データがモデル入力へ届きます。

`finish` は候補の提出です。同じworker・同じengineが `tools=[]` で依頼、条件、完全な該当抜粋、未確認点を一回照合し、受理された結果だけV3報告になります。requestの網羅性や根拠との意味上の対応はこのモデル判定に委ねます。形式・値・根拠の所有者と版・取消・期限・profileのrevision/generationはホストが検査します。意味検証は任意の業務判断の正しさを証明するものではありません。

確認できない値は `unknown/null`、未達は `unsatisfied`、許可された適用外は根拠付き `not_applicable` として残します。必須条件がunknown/unsatisfiedならansweredにできません。外部資料の条件は `externalRules` に出典付きで保持し、profileを自動登録したり凍結した利用者条件を書き換えたりしません。チェックと外部ルールだけが使う根拠も失効検査の対象です。

構造修復は調査と意味検証を合計して一回まで。意味検証の不支持、枠不足、期限切れ、取消、profileの改訂・無効化では未検証候補を回答に使いません。履歴は `package:history.research@2` です。旧revision(`package:web.quick@1`・`package:web.research@9`・`skill:web.research@8` など)とV1/V2報告のreaderは維持しますが、新しい調査には使いません。

## 要件の登録と改訂

APIは既存の認証・origin検査を使います。GET `/api/capabilities/requirements` と `/:id`、PUT `/:id`、POST `/:id/state` を提供します。新規PUTの `expectedStateToken` はnull、改訂・状態変更は取得した現行tokenが必要です。競合は409で、勝手に再試行しません。同じ内容のPUTはrevisionを増やさず、無効なprofileの改訂も無効のままです。無効化・再有効化・改訂は既存の実行を失効させます。

```sh
bun run cli -- requirements list --json
bun run cli -- requirements show criteria --json
bun run cli -- requirements import criteria ./profile.json new --json
bun run cli -- requirements import criteria ./profile.json <state-token> --json
bun run cli -- requirements disable criteria <state-token> --json
bun run cli -- requirements enable criteria <state-token> --json
```

profileは最大12要件・16 KiB、同時選択は4profile、合成後は12要件まで。有効profileは32件かつ会話catalogは8 KiB以内。値のJSON SchemaはZodの標準変換で検証し、未知keyword、正規表現、条件分岐、参照、default、coerceを許しません。数値・文字列・配列・objectの型と範囲だけを表現します。超過や不正なschemaを切り捨てて受理しません。完全な例は [評価データ](../api/application/testdata/llm-native/cases.json)とprofile JSONを参照してください。

## タイマーと音声

タイマーは権限・操作receiptを再検査したうえで、label、状態、残時間、期限を含む全itemsを回答モデルへ渡します。ページングされた一覧は `complete:false`、失敗は固定codeを含む構造化結果です。回答直前に状態をrefreshし、ユーザー本文を位置・内容検索で書き換えません。操作の再実行やホストでの定型文章化は行いません。

非空の本入力のASR後、既定controlモデルが主要言語を一回判定します。8秒・256 tokenが上限で、判定結果の全言語が許可リストにありconfidenceが0.8以上の場合だけ進みます。判定不能・不正・不在は `asr_language_unverified`、許可外は `asr_language_not_allowed`。previewと空ASRは言語判定を呼びません。ASRと言語判定のreceiptを同一transactionで受理し、回答・操作・TTSの検証parentにも言語判定を結びます。Web用Luna権限は流用しません。

感情判定は引用・否定・定義文を保持して全6候補を提示し、非空回答で一回判定します。候補・判断基準・声色presetは `delivery/data/speech-delivery.v1.json` に置きます。語句・句読点から抑揚を推定せず、判定失敗時は保存済みの声設定を使います。

## 固定資料とliveの検証

[検証記録](../spec/verification/llm-native-2026-10-10/README.md)でfixture、liveモデル＋人工固定資料、実Web取得、実機器を分けています。固定資料adapterは提示URLの完全一致で本文を返し、ネットワーク・意味分類を使いません。expectedを実モデルへ渡しません。fixtureの意味検証stubはhost契約を試すもので、モデルの意味判断に対する合格記録ではありません。

```sh
EUMENES_LIVE_LLM_NATIVE=1 bun scripts/llm-native-live.ts --suite all --cases api/application/testdata/llm-native/cases.json --out spec/verification/llm-native-2026-10-10 --repeats 2
```

既存LARM接続URL・認証が必要です。製品DB・設定をコピーせず一時DBを使い、登録は認証済み管理API、推論は既存公開操作を通します。各caseは2回。engineが違う結果を合格にせず、Luna未設定を既定engineへ置換しません。意味確認がuncheckedの結果やskippedを合格にしません。実ASR・マイク・スピーカーの3往復は別の受入です。

根拠一覧は8 KiB以内の参照metadataとし、正確な抜粋は取得資料の観測に一度だけ提示します。各stepで以前の抜粋と後半の留保も再提示します。新しい抜粋の登録は、title・URL等を含む実際の提示資料(根拠一覧と観測)が資料枠に収まる場合だけ行います。資料枠は最大32 KiBで、64 KiBから指示・依頼・guidance・要件契約と、操作履歴(4 KiB)・修正状態等の予約を差し引いた残りです。同じ資料が複数の操作から届いた場合は一度だけ提示します。収まらない場合は登録せず、収まらなければ容量到達として操作を閉じ、提示済みの根拠で不足を含めて報告します。replayで過去の観測が後ろへ移った場合も、未提示の新規登録だけを取り消して枠内に保ちます。全体64 KiB、根拠64件が上限です。検索後に抜粋が足りなければ許可URLの本文を予算内で読みます。WebはV2の短い報告、historyはprofile・V3・意味検証を維持します。全経路のsystemに共通規則(資料は未信頼、未提示の事実を補わない、残時間60秒以下またはcanInvoke=falseでfinish、JSON一つ)を置き、経路の方針文で置き換えません。契約違反の修正診断(path/codeのみ)はタスク入力ではなく専用の列に保存し、受理時に消します。会話側の操作拒否は、分類・公開済みツール名・呼出し数・validationPath/codeだけを `dialogue.operation_rejected` に記録します。
