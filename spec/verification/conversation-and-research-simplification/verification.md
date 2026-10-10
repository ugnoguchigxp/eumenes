# 会話と調査の構造整理の検証

2026-10-10 Asia/Tokyo。参照commitは `30f9524`、検証対象は継続セッションで仕上げた作業ツリー。実装を先に終え、固定応答の個別試験、領域別検証、固定条件live、全体検証の順に実施した。

## 実装とfixture

旧invocationHint・専用報告補正・agentのfacts引数・旧出力変換を除去した。共通予算は通常経路、学習済み経路、取得先切替で共有する。既存のSQL migration、製品データ、設定、取得先学習、旧保存結果のreaderは維持した。

`bun run verify -- --domain <name>` は agent-runtime、tool-runtime、dialogue、inference、memory、web-research、research-routes、conversation、voice-dialogue の9領域で通過した。applicationの固定応答試験と計測試験は68件成功した。未提示参照の拒否、取消と遅延結果の非採用、原文の訂正・撤回、離れた三範囲の根拠保持、残り70秒から45秒への時間境界、同一操作の再提示と有限終了、取得先切替の終了予約を確認した。

最終版の調査契約・音声・安全な診断ログの関連試験は55件成功した。報告schemaはoutcomeを判別する固定unionとし、モデルに提示するoneOfとホストの条件を揃えた。欠けたsummaryの診断はreport.summaryの型違反として記録し、本文・未知のキー・秘密はログに出さない。

新しい境界試験では、成功済み取得の再提示後の次stepが終了専用になり、外部取得回数と形式修復回数が増えないこと、残り45秒で取得先を切り替えても新規検索を始めないことを確認した。

## 固定条件live

製品SQLiteの `settings_document` からLARM接続先・profile・audienceとLLM routeだけを読取り確認した。製品DB・会話・設定全体・学習情報・秘密は隔離DBへコピーせず、既存backend認証経路と一時DBを使った。接続先は `http://192.168.0.130:9810`、profileは `SAAA-gemma4-26b`、audienceは `saaa-desktop`、実モデルの識別は `gemma4-26b-a4b`。モデル、予算、質問、資料は比較する2回の間で変更していない。

| ケース | 1回目 | 2回目 | 受入判定 |
| --- | --- | --- | --- |
| 通常会話 | モデル1回、8.064秒。SSE本文表示開始7.245秒 | モデル1回、4.563秒。SSE本文表示開始4.376秒 | 連続2回成功 |
| Memory OFFの履歴 | 原文は取得・検証済みだが、依頼したhistory.readを省略。モデル5回 | 同じ読取り省略。モデル4回 | 未合格。2回連続の同じ失敗で一括再試験を停止 |
| 長文のSQLite公式資料 | read→find→read_savedでLIMIT/OFFSETの原文根拠を確認。モデル7回、70.523秒 | read→find後、未提示の根拠を報告。一回の修復後もunknown_evidenceで拒否。モデル6回、37.645秒 | 連続2回成功は未達 |

上表のモデル回数は初回会話・子の調査・最終回答・修復を含む。SSE本文表示開始はclientの観測時間であり、画面の描画完了や音声開始ではない。変更前と同条件の性能比較は実施しておらず、性能改善や一般的な成功率は主張しない。

履歴の失敗では、ホストの形式・権限検査による拒否ログはなく、原文に対応する報告の採用条件も通過した。しかし指定された周辺読取りは実行されていない。結果品質の受入を成功へ変更しない。長文の失敗は外部通信失敗ではなく、モデルの根拠参照の契約違反であり、ホストは本文や主張を補って成功にしなかった。拒否時の原文や生応答は運用ログへ追加しない。

live後の変更は旧型の整合、音声試験のデータ参照、新報告schemaの判別と診断の修正であり、調査schemaの最終版に対するliveの再実施は行っていない。単一の固定出力によるunknown_evidence拒否と一回修復の再現はfixtureで確認済み。liveの読取り省略を、ホスト側に専用needs・次操作推奨・追加plannerを復活させて補正する変更は行っていない。

安全な集計とログは `verification-reports/conversation-simplification/` に保存した。通常会話・履歴は `conversation-live.json`、長文は `web-live.json`、各段階の推論時間と実モデル識別を含む。旧の試験結果や失敗結果は最終版の合格結果へ混ぜない。

## 全体検証

最終版の `bun run verify:all` は通過した（405.795秒）。検証開始と終了のソースdigestは一致した。最終digestは `bb797e5e73af638ea04c215e02bd4e4ee50f6682d8eb8217a2c475531357c50e`。

| 検査 | 最終結果 |
| --- | --- |
| domain・SQL境界、domain資料、サイズ、整形、lint、型 | 通過 |
| backend・runner・scripts | 1,247成功、1 skip、0失敗 |
| Web | 254成功 |
| API client | 329成功 |
| design-system | 型検査と1,086試験成功 |
| Web build | 成功 |
| ブラウザfixture | 42成功、1 skip |

skipは実Local Provider試験と、合成マイクを使うAudioWorklet試験であり、成功には数えない。途中の全体検証は静的な型不整合、音声試験の旧データ参照、報告診断の項目欠落で止まり、失敗後は該当試験だけで修正を確認した。最終版の合格結果は `verification-reports/conversation-simplification/all.json` と `all.log` で分けて保存した。

## 未受入

会話と調査の構造実装とfixtureを完了したが、P5全体の受入は未完了。履歴の指定操作と長文の連続2回成功は未達。天気の続き・再検索・別資料・学習済み経路の実Provider比較はfixtureと区別して未実施とする。

音声の取消・採用はfixtureを通過した。実マイクと実音声出力での3往復、割込み、発声開始の受入は未実施。音声MVPの完成は宣言しない。


## Web汎用化後のverify（2026-10-10）

専用処理の撤去を実装してから、変更領域と利用側のverifyを個別に実行した。

| 領域 | 結果 |
| --- | --- |
| web-research | verify通過、39試験成功 |
| capabilities | verify通過、12試験成功 |
| research-routes | verify通過、backend 14試験・Web 7試験成功 |
| agent-runtime | verify通過、backend 43試験・Web 9試験成功 |

旧revisionの試験期待値と、学習コード削除後の未使用引数を修正して各領域を通過した。記録は `verification-reports/conversation-simplification/generic-<domain>.log` に保存した。

ユーザーが指定したverifyを広く解釈し、verify:allも実行してしまった。最初の実行は新しいapplication試験のProvider識別子の型不整合で停止し、契約に合わせて修正した。再実行はユーザーの指示によりbackend試験中に停止した。今回のverify:allは未完了で、全体合格を主張しない。上記の旧全体検証のdigestは今回の汎用化後の版を対象としていない。追加live・実機器検証は実施していない。

## Luna接続後の必要なverify（2026-10-10）

実装・回帰ケースの追加と差分確認を終えてから、必要な領域だけに分けてverifyを実行した。

| 領域 | 結果 |
| --- | --- |
| inference | verify通過、backend 36試験成功 |
| agent-runtime | verify通過、backend 45試験・Web 9試験成功 |
| dialogue | verify通過、backend 95試験・Web 2試験成功 |

Codex CLIの代替実行ファイルを使うfixtureで、固定モデル・指定context・native操作の無効化・秘密を渡さない環境・出力上限・process group取消とcwd掃除を確認した。共通receiptでの採用、取消された遅延結果の拒否、選択した担当のstep間保持、Webの共通worker利用、語句によらないLLM選択、履歴へのLuna指定・利用できないツールの拒否を確認した。

dialogueの初回verifyは新migrationのafter宣言漏れで停止した。適用順だけを修正し、dialogueとmigration所有領域のinferenceを再実行して通過した。SQL本文とagent-runtimeの実装は変更していない。記録は `verification-reports/conversation-simplification/luna-<domain>.json` と `.log`、初回失敗は `luna-dialogue-before-migration-fix.log` に分けて保存した。

Codex Luna実サービスへの呼出し、追加live、実機器、verify:allは実行していない。fixtureの通過を実接続の受入と混同しない。利用にはbackend実行ユーザーのCodex CLIインストール・ログインとモデル利用権が必要である。

## ユーザー指定によるLuna実接続の最小確認（2026-10-10）

後続の依頼で実接続を確認した。製品DBを使わず一時DBへ共通toolchainを構成し、ユーザー指定のLunaへ直接委任した。実Codex CLI（gpt-6-luna）、inference、queue、Web取得、資料guard、worker報告、receipt採用を使い、終了後に一時DBと本文を削除した。自動振り分けと会話側の最終文章生成は今回のlive対象外である。

指定URL `https://example.com/` の本文取得は成功し、根拠付きのanswered報告がready_for_answerまで戻った。約20.9秒、Luna呼出し2回、Web本文取得1回、根拠資料1件で、2つの推論receiptはいずれも採用済み。記録は `verification-reports/conversation-simplification/luna-live-direct-result.json`。

先に試した検索付き調査は約48.5秒で報告未成立となった。Luna呼出し自体は4回とも成功したが、検索がweb_invalid_inputとweb_timeoutで失敗し、未許可URLの読取りはtool_url_out_of_scopeで拒否された。検索Providerは対応するlanguage・region組合せを要求する。記録は `luna-live-search-result.json`。指定URLの成功を検索付き調査全体の成功とは扱わない。

確認は上記2件で終了した。verify:all、追加のverify、live一式、実機器試験は実行していない。

## 現在の担当を簡単なWeb確認に限定（2026-10-10）

実装を先に完了し、その後にdomain単位のverifyを実行した。現在のWeb担当は `package:web.quick@1`（lookup/readのみ、検索1回・取得1回、モデル最大5回）へ変更した。Lunaは `package:web.research@9` の長文・複数資料用ツールを保持する。担当選択はLLMのツール選択に委ね、質問語句による振り分けは追加していない。無効なLunaの代わりに現在の担当で重い調査を行わないよう指示した。

- capabilities: verify通過、backend 17試験成功。新しい簡単な確認用の権限と、Luna用権限の保持を含む。
- agent-runtime: size・format・lint・型確認は通過。backendは24成功・22失敗。失敗は削除済みの旧取得先初期化を前提とした試験、旧報告schema、追加された要件検証のmigration・fixture未対応など。今回の簡単な確認用の予算と、語句を変えても予算が変わらない試験は成功した。domainのverify通過とは扱わない。
- dialogue: size・format・lint・型確認、backend 95試験・Web 2試験は成功。ただし実行中のソース変更をverifyが検出したため、最終gateは無効となった。安定したrevisionの通過とは扱わない。

記録は `verification-reports/conversation-simplification/quick-<domain>.log`。この追加作業ではliveとverify:allを実行していない。同じ作業ディレクトリで別変更が進行していることを示す更新とソース変更検出があり、未対応の別変更を上書きする前にユーザーへ並行作業の有無を確認した。

ユーザーは別セッションでの作業中であることを確認し、「今回の変更だけ仕上げる」と指定した。簡単な検索用のパッケージ・権限・予算、LLMによるLuna選択、関連文書の変更が残っていることを差分で確認した。別セッションの要件管理・意味検証と、その既存試験の修正は今回の完了範囲に含めない。並行変更中のverify再実行は行わず、上記の未通過・無効の結果を維持する。
