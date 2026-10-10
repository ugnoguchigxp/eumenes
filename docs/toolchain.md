# 会話からの調査(toolchain)

通常の会話入力からWeb検索・読取りを選べます。`EUMENES_TOOLCHAIN_ENABLED` は既定 `1`、`0` なら従来の会話生成へ戻ります。会話LLMが現在の調査担当（LARM）またはCodex Lunaを選びます。内部JSONを読み上げや態度収集へ渡しません。子の待機中は推論枠を解放します。

簡単な語句確認と短い最新情報の確認は `research` の `web` を使います。現在の担当は検索1回・ページ取得1回の `package:web.quick@1` に限定し、保存本文の探索や複数資料向けの処理を渡しません。モデル呼出しは報告候補の意味検証・修正分を含めて最大5回です。詳しい説明、長文・複数資料の整理、比較、多数のニュース収集には `research_web_luna` を選べます。リアルタイム情報も対象です。振り分けは会話の文脈と依頼を持つLLMに任せ、語句辞書や文字数の条件を置きません。会話履歴は従来の `research` の `history` を使います。

Lunaはbackendで `codex exec --model gpt-6-luna` を実行します。backendの実行ユーザーでCodex CLIをインストール・ログインし、PATHから起動できるようにしてください。実行ファイルは `EUMENES_RESEARCH_CODEX_EXECUTABLE` で指定できます（既定 `codex`）。CLIが見つからないときやWeb調査が無効なときはLunaのツールを公開しません。認証・モデル利用権・接続の失敗は調査失敗として扱い、別モデルへ自動変更しません。

各stepは空の一時ディレクトリでephemeral・read-onlyとして実行し、ユーザー設定・exec規則・native検索・shell・JS実行・MCP・apps・追加エージェントを使いません。CLIの保存済み認証だけを再利用し、製品DB・LARM認証・設定を渡しません。Lunaは既存のinvoke/finish契約で操作を選び、Eumenesの検索・本文取得・保存本文・資料guard・根拠参照を使います。担当は子の入力と推論requestへ保存され、step間で変わりません。共通の期限・取消・receipt採用検査を通し、CLIの終了と取消では所有するprocess groupを停止します。Providerの生応答はログへ保存しません。CLIの接続方法は[公式の非対話実行仕様](https://developers.openai.com/codex/noninteractive/)に従います。

子は取得本文を読み、短い要約、主張、出典、未確認点を返します。メインへ本文・生引用・ページタイトルは渡しません。主張の引用が実際に子へ提示した資料に含まれるかを確認しますが、この検査だけで主張の意味まで正しいと保証するものではありません。メインでも報告を未信頼データとして扱います。調査cardに進行状態・停止・出典・確認できなかった点を表示します。

話題や地域を限定せず、検索・本文取得・保存本文の確認を使います。検索語、取得先、資料の解釈はLLMが選びます。天気・株価専用の読取りや、発話の固定文法による取得先学習は実行しません。上流の取得拒否やguard拒否を迂回しません。結果データは14日、本文を含まない処理metadataは30日で整理し、既存の会話は残します。

`EUMENES_LIVE_TOOLCHAIN=1 bun run verify:live -- --domain agent-runtime` は一時DBを持つ隔離backendを起動し、実LARMと公開データで天気・株価を確認します。LARM認証はbackendの環境変数から読み、通常DBは使いません。判定は子の報告と最終回答の数値まで確認します。[実装・検証記録](../spec/verification/toolchain/README.md)を参照してください。

domain の責務は [domains.md](domains.md)、Web 取得は [web-research.md](web-research.md)、保存済みの取得先と手順は [research-routes.md](research-routes.md) を参照してください。

## 要件profileとV3報告

利用者が再利用する確認基準は `kind:requirement` のデータとして登録します。要件profileは実行権限を持たず、package検索・ツールの依存閉包へ入りません。会話モデルは提示された短いrefから適用するprofileを選びます。workerは最初の操作と同じ応答で依頼の条件を抽出し、ホストが登録profileと合成して、取得開始前に凍結します。原文、版付きSKILL/profileの本文、選択した要件データがモデル入力へ届きます。

`finish` は候補の提出です。同じworker・同じengineが `tools=[]` で依頼、条件、完全な該当抜粋、未確認点を一回照合し、受理された結果だけV3報告になります。requestの網羅性や根拠との意味上の対応はこのモデル判定に委ねます。形式・値・根拠の所有者と版・取消・期限・profileのrevision/generationはホストが検査します。意味検証は任意の業務判断の正しさを証明するものではありません。

確認できない値は `unknown/null`、未達は `unsatisfied`、許可された適用外は根拠付き `not_applicable` として残します。必須条件がunknown/unsatisfiedならansweredにできません。外部資料の条件は `externalRules` に出典付きで保持し、profileを自動登録したり凍結した利用者条件を書き換えたりしません。チェックと外部ルールだけが使う根拠も失効検査の対象です。

構造修復は調査と意味検証を合計して一回まで。意味検証の不支持、枠不足、期限切れ、取消、profileの改訂・無効化では未検証候補を回答に使いません。新規Webは `skill:web.research@8` を使い、Lunaの汎用調査は `package:web.research@9`、通常の短いWeb確認は `package:web.quick@1`、履歴は `package:history.research@2` です。旧revisionとV1/V2報告のreaderは維持します。

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
