# 応答遅延の実装と検証記録

2026-10-24。[合意した計画](../eumenes-response-latency-plan-2026-10-23.md)に基づく。mainで作業し、稼働サーバーやLARMの停止・起動・再起動、LARM設定変更、別チャットへの送信は行っていない。

## 適用状態

| 対象 | 状態 |
| --- | --- |
| E0: 段、入力総量、S/P/H/W/V/R、候補schemaの推定量と正式計数の相関 | 実装済み。本文・引数・入力digestは運用ログに記録しない |
| E1: 初回から修正規則を固定し、棄却出力と診断を現在依頼の直前に置く | 通常動作へ適用。修正上限1回、元の現在依頼・ID・先頭指示を維持 |
| E2: 操作名と引数を組にするschema、共通executor、既存validatorへの変換 | 実装済み。明示指定する比較候補。通常動作はnativeのまま |
| E3: 完了判定・選択試験への同じ契約の適用 | 比較候補として実装。状態判定・継続上限・承認方式は変更しない |
| E4: 固定判断指示を先頭systemへ統合する同内容の配置候補 | 比較runnerに実装。通常のContextWindow配置は未変更 |

内部の`operationOutput: "json-schema"`を指定した場合だけ候補を使う。失敗時にnativeへ再送するフォールバック、モデル名・profile名による切替、DB設定、語句による判断分岐は追加していない。

LARM、OpenAI互換、Claude/Codexのschema受渡しを同じinference requestへ接続し、route・snapshot・期限・権限・receipt・忘却refsを維持した。厳密schemaの任意項目をnullとして表す場合だけ元の省略形式へ戻し、実際にnullableな値・未知候補・不正な業務値は変更せず既存validatorへ渡す。ローカルschema参照とnullable unionも試験した。

LARMのgrammarで検索文の`maxLength: 2000`を含むschemaがHTTP 500となった。同じschemaの上限160、長さ制約なしは成功し、正規表現による同じ2000文字上限も500だった。このため操作用のLARM grammarだけ文字列長の範囲を説明へ移し、元のschemaとhost検証では上限・下限を保持した。2001文字の検索文を拒否して一度だけ修正する回帰試験を追加した。

候補の説明と引数schemaはモデルの入力にも提示する。最終実装では先頭systemへ統合し、後方systemへの依存を避ける。この変換により主回答のMemoryや可変状態全体のProvider互換性まで解決したわけではない。

## 重要な発見: 会話履歴より後のsystemがモデルへ届かない

合成資料にある値を答える同じ依頼で確認した。Eumenesの実送信JSONに資料が存在することを、メッセージのroleと文字数だけを記録して確認した。

| 資料の位置 | 正式入力token数 | 資料の値を回答 |
| --- | ---: | --- |
| 先頭systemに統合 | 4,279 | 成功 |
| 先頭に連続する2個目のsystem | 4,279 | 成功 |
| 先頭systemを3個にした場合の2個目 | 4,279 | 成功 |
| 会話履歴の後ろのsystem（資料8,421文字） | 66 | 失敗 |
| 同じ位置のuser | 4,283 | 成功 |

確認した範囲は「会話履歴の後ろのsystem」であり、すべての2個目以降のsystemが欠落するとは結論しない。LARM配下の入力処理と、Eumenesのrole配置の互換性問題として扱う。送信済みと、モデルが資料を読めたことを区別する必要がある。再現runnerは`bun scripts/response-decision/visibility.ts --run`。資料や回答本文は結果へ保存せず、読取り成否・role・文字数と通常の安全な運用ログだけを保存する。

根拠は`verification-reports/response-latency-implementation-2026-10-24/context-visibility{,-leading}.json`と対応する`*-backend.jsonl`。再現は同じ内容を3ケースと対照2ケースに分けて実行した。モデルの意味判断をコードで代替する修正や、LARM側への変更はしていない。

主回答の参照・完了判定の状態全体を別roleへ一括置換すると、指示・参考情報・履歴の境界とcache位置に関わる。まずLARM側のsystem保持契約を確認し、この再現で受け入れる。Eumenesで別の直列化方式を導入する場合は追加設計が必要。

## live比較と採否

保存済み接続を読み取り専用で取得し、サーバーを立てずにR1だけを呼び出した。選ばれた操作は実行していない。候補順・内容・依頼を固定し、armの実行順を回転した。以下は初期候補の探索用12ケース×3回。boot epochとconfig revisionは全件同一だった。

| 初期候補 | 件数 | 実行失敗 | 期待する操作・kind・承認との一致 | 修正あり | 中央値 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| native・従来配置 | 36 | 0 | 27 | 1 | 5,359 ms | 8,998 ms |
| schema・従来配置 | 36 | 5 | 22 | 6 | 4,776 ms | 9,021 ms |
| schema・固定指示を前へ配置 | 36 | 7 | 22 | 7 | 4,234 ms | 8,602 ms |

失敗を除いて集計していない。外部情報や保存会話の依頼を`answer`へ分類し、修正を使い切る失敗がある。速度だけを理由に採用せず、通常動作をnativeのままとした。native基準にも既存の判断不一致があり、これを本変更で解消したとは扱わない。この探索では操作・kind・承認を採点し、現runnerには即時操作の期待引数との照合も追加した。

この初期比較の後、入力互換性の対照試験を追加し、schema候補の提示と固定指示候補を先頭systemに統合するよう修正した。したがって上表を最終候補の品質値として流用しない。schema提示を先頭へ統合した版の短い雑談・一般知識のsmokeは各候補2/2成功・修正0だった。E4の固定指示の統合候補はその後更新しており、fixtureでの同内容・現在依頼保持までの確認である。いずれも最終候補の品質受入の代わりにはならない。

同じ役割配置が正しく読まれる構成を確定する前に、独立24ケース×5回の採否試験を合格扱いにしない。現時点ではE2/E3/E4の通常動作への採用を保留し、性能改善を検証済みとは宣言しない。比較runner・ケース・実送信JSONの共通byte観測は`scripts/response-decision/`にある。byte共通長はProvider templateの共通token長やcache再利用数ではない。

### cacheの観測

S/P/H/W/V/Rの合成入力を約1.4万**推定**tokenで作り、同一主接続で再送・背景更新・補助4件後を観測した。ただし正式入力は2,682 tokenで、背景を変えても同じだった。後方systemの欠落を確認したため、約1.4万正式tokenのcache受入としては無効である。

この2,682 tokenの範囲では、初回cache 0・prefill 10,378.815 ms、即時再送cache 2,678・prefill 28.466 ms、補助4件後もcache 2,678・prefill 28.551 msだった。以前確認した約1.47万tokenの追い出し問題が解消したとは結論しない。coldを強制するcacheクリアや設定変更もしていない。結果は`verification-reports/response-latency-implementation-2026-10-24/cache-live/`。

## 固定試験と静的検査

最終の先頭統合を含むコードで実行した結果。

- 関連9 domain: Bun 1,384件、Web 89件、DesignSystem 28件、計1,501件成功。
- 公開会話入口のfixture: 24件成功。選択・完了/継続・task・発話前の取消・制御本文の非公開を確認。
- 比較用入力・配置・prefixのfixture: 4件成功。
- 比較runnerの模擬実行: 開発12＋holdout24ケース×3 arm、108件を処理。LLM品質の成功数には数えない。
- 型検査、変更対象の整形・lint、SystemContext生成物検査に成功。
- `verify`は境界検査とSystemContext検査を通過した後、変更していない`generation-prepare.ts#createPrepare`の既存307行に対するサイズ上限300行で停止。基準を緩めず、以降の検査を個別に実施した。

標準検証: `bun run verify -- --domain dialogue --domain inference --domain larm --domain memory --domain delivery --domain voice-dialogue --domain agent-runtime --domain tasks --domain pipelines`。

結果の保存先は`verification-reports/response-latency-implementation-2026-10-24/`。最終domainは`domains-accepted.log`、公開fixtureは`public-fixtures-accepted.log`。他の作業の差分も存在するため、所有する変更を分け、入力ファイルのhashを試験前後で点検した。検証中の他作業によるapplication組立て2ファイルの変更は、今回のdomain試験の対象外で、公開fixture開始前の変更だった。今回の実装ファイルに検証中の変更はなかった。

修正は語句別の意味判断・固定回答・新しい承認方式を追加していない。専用のProvider投影は、再現した文字列長grammar失敗への最小の接続処理であり、hostの契約を弱めていない。ContextStillの本会話累計はcompile 3回・eval 5回。

## 未実施・続行条件

ブラウザE2Eはサーバー起動を伴うため未実施。再起動後の製品会話、対応する入力契約での独立holdout、約1.4万正式tokenのcold/warm・背景更新・補助4件後の再計測、実マイク・再生3往復は未受入。音声MVPや遅延問題の解消を宣言しない。

追加の通常動作への採用は、後方systemが失われないLARM/Provider入力契約の確認、またはEumenes側の追加直列化設計の合意と、その後の同一条件での品質・時間比較を条件とする。
