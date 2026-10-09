# Web取得とLuna調査およびキャッシュの実装計画

作成日: 2026-10-09 Asia/Tokyo
状態: 初期実装に着手済み。第1〜14章は設計・工程の計画であり、実装済みの範囲と検証結果は第15章に記録する。

範囲更新: Web調査の記憶利用に必要な変更は、Eumenesに加えて別プロジェクト `../eumenes_memory` も実装対象とする。既存の公開機能を再利用し、不足する共通契約・永続処理・試験を本体で拡張する。具体的な分担と配布・接続工程は第13章に記す。

Eumenesの簡単な調べものはllm-fetch、天気・株価は専用データAPI、込み入った調査はCodex Lunaで処理する。鮮度が重要な情報は原則毎回取得する。SQLiteキャッシュは比較的変わりにくい資料本文と調査結果に限定し、使われなくなったデータを自動削除する。

## 1 採用方針と範囲

| 対象 | 主経路 | 永続キャッシュ |
| --- | --- | --- |
| 用語、単純な事実、公式仕様 | llm-fetchで検索・本文取得 | 安定した本文だけ保存。検索一覧は初版では保存しない |
| 最新ニュース一覧 | RSS、ニュースAPI、必要時に検索 | 保存しない |
| ニュース本文 | llm-fetch | 保存可。ただし再利用時に更新確認が必要 |
| 天気・現在株価 | 用途別API adapter | 保存しない |
| 比較、背景、複数論点の調査 | Codex Lunaと内蔵live検索 | 条件が一致する、時点依存の少ない完成結果だけ保存 |
| 今日の市場分析など | 新しいデータとLuna | 完成回答は再利用しない。安定した背景資料だけ再利用可 |

Lunaが確認した資料を全件llm-fetchで再取得しない。原文の保存や厳密な引用照合を要求された場合にだけ追加取得する。本文を取得した事実、モデルによる原文確認の申告、引用の機械的な一致検証は区別する。

初版に含めるものは、取得adapter、有限回の経路選択、Lunaの背景ジョブ、キャッシュ、取消、出典表示、API・CLI、必要最小限の設定である。Firecrawl導入、DeepStill統合、全文検索・ベクトル検索、意味の似た質問へのキャッシュ転用、自動巡回、全サイトのクローラー、MemoryやWorld Modelへの自動登録は含めない。

## 2 現在の実装と追加が必要な箇所

| 確認箇所 | 現在の契約 | 今回の追加 |
| --- | --- | --- |
| `api/infrastructure/sqlite/index.ts` | backendがwriterを所有し、書き込みを直列transactionで処理。read-only接続とprocess lockあり | 専用キャッシュDBの起動設定、限定的な容量回収操作 |
| `api/domains/queue/types/index.ts` | prepare・execute・settle、generation、取消、復旧方針を持つ | Web調査handlerと資源枠を登録 |
| `api/domains/scheduler/` | 利用者の予約を永続化してQueueへ渡す | 初版のキャッシュ掃除は予約を増やさずbackendの保守処理として実行 |
| `api/domains/inference/contracts/index.ts` | 文字列messageのanswer・answerStreamが中心。汎用tool call契約なし | 有界な取得計画を生成する内部操作を追加 |
| `api/domains/dialogue/` | 会話revision、Queue、回答採用を所有 | 調査の依頼・待機・結果の採用を公開操作で接続 |
| `api/application/migrations.ts` | migrationは配列位置で識別。vendorのmigrationも含む | 適用済み配列の末尾にだけ追加 |

本章の表は着手時点の比較である。追加domain、API、テーブルの実装状況は第15章を参照する。現在のInferencePortが既にツールを使えるものとして実装を始めない。

作業開始時に未コミット変更と最新のdomain依存を再確認する。他の進行中作業を上書きしない。SAAA、ContextStill等のDB・設定・秘密はコピーしない。

## 3 所有境界

Eumenesの新規domainは初版では `web-research` 一つとする。取得方針、provider adapter、HTTP cache policy、取得台帳のSQL、試験をこのdomainに置く。調査資料・メモの共通保存、検索、期限判定、忘却はメモリーパッケージの公開操作を使う。必要な本体拡張は第13章の対象とし、同じ機能をEumenes側に複製しない。汎用cache domainや汎用ToolChainは先行導入しない。

| 所有者 | 責務 |
| --- | --- |
| `web-research` | 入力検証、軽量取得、Luna実行、正規化、出典、結果台帳、キャッシュ、掃除 |
| `dialogue` | 会話文から取得目的を作る、会話との対応、結果を回答に採用する判断 |
| `inference` | 現在の推論providerで取得計画・最終回答を生成する操作。Web取得そのものは行わない |
| `settings` | provider設定、送信許可、秘密、設定revision |
| 別プロジェクト `eumenes_memory` | 資料・調査メモの共通契約、保存・検索、期限・選択・失効検証、依存関係と忘却。接続・transactionはホストが所有 |
| `queue` | lease、期限、資源枠、取消、復旧。Web固有の業務判断は持たない |
| `application` | 主DB・cache DBと各serviceの構築、公開callbackの接続、起動・終了 |

依存の追加案は `dialogue → web-research → queue / settings`。web-researchからdialogue・conversation・voice-dialogueへ逆参照しない。完了時の会話への通知はapplicationで公開callbackを接続する。`scripts/domains.ts`、境界検査、`docs/domains.md`に反映する。

主DBの調査台帳・Queue・会話採用など、整合性が必要な保存は既存writerの同じtransaction内で公開操作を合成する。キャッシュは別DBへのbest-effort保存であり、主DBとの原子性を要求しない。cache保存失敗を、既に確定した調査や会話の失敗へ変更しない。

## 4 取得と委任の流れ

1. 明示された取得種別、対象、期間、地域、鮮度要求を検証する。現在株価などは専用adapterへ直接振り分ける。
2. 自然文の場合は既存の推論providerで一度だけ有界な取得計画を作る。計画は `none / lookup / read / weather / quote / news / research / clarify` の列挙と型付き引数に限定する。任意コードや任意HTTP headerを生成させない。
3. backendが計画をschema、設定、予算で再検証する。曖昧な地域・銘柄・対象日は確認し、推測で確定しない。計画生成に失敗した場合は一度だけ形式修復し、それでも失敗したら外部実行しない。
4. 軽量取得は対応adapterを呼ぶ。安定した本文だけキャッシュを確認する。結果不足の場合は最大1回、検索語または資料選択を修正する。
5. 複数論点、資料間の矛盾、根拠不足が解消しない場合はLunaへ一度だけ委任する。明らかに複雑な依頼は最初からLunaへ送る。
6. 正規化した結果を最終回答の材料として渡す。外部本文はuntrustedの資料であり、システム指示や実行許可に昇格させない。

ニュース・天気・株価の取得失敗を、古いモデル知識による回答で補わない。bot challenge、rate limit、認証エラー、ガード拒否は「調査が複雑」の判定に使わず、それぞれの失敗として返す。ガード拒否をLunaや別providerで回避する自動処理は設けない。

初期予算案は軽量検索最大5結果・本文最大3件・全体15秒・モデルへ渡す本文合計12,000文字。超過・省略・部分失敗を結果に残す。安全な切り詰めとガードを通した本文だけを採用する。数値はlive検証で調整する。

短い調査と背景調査は同じAPI契約で扱う。背景調査の開始で会話・音声処理を占有し続けない。親会話の実行枠を解放してLunaを開始し、待機中の親が子の必要資源を占有する構成を避ける。通知・回答の採用時に、親runのrevision・取消状態・送信許可を再確認する。

## 5 Providerと正規化契約

### 軽量取得

llm-fetchはversionを固定し、既存の `search / read / searchAndRead / toolset` を利用する。DuckDuckGoのbest-effort性、既存Brave/custom providerの拡張点を維持する。新しい有料契約やproxy回避を前提にしない。

先行調査でMarkdown未対応・ガード拒否・bot challengeを観測したが、少数例であり現行版の再検証が必要。Markdown本文取得と拒否理由の判別が未解決なら、その制約を残した限定提供とし、全面対応を宣言しない。llm-fetch側の改修は別リポジトリの作業として分け、未リリース機能をEumenesの利用可能機能とみなさない。

天気・株価・ニュースの具体providerは未選定。工程P0で対象地域・市場、更新間隔、遅延表示、利用条件、保持可否、料金を確認して各用途一つを選ぶ。未設定・未対応用途は `provider_unavailable` とし、fixtureが通っただけでlive対応済みにしない。

### Luna

ContextStillのCodex調査実装を設計の参考に、Eumenes内のadapterとして実装する。既存のCodexチャットへメッセージを送る方式にはしない。新規の隔離したSDK実行で `gpt-6-luna`、reasoning low、live検索を使い、shell・MCP・plugin・他のagent呼び出しを無効化する。利用可能な設定は採用SDK/CLIで再検証する。

backendの既存ChatGPT認証を使う個人利用が対象。認証情報をリポジトリ・DB・Web・ログへ保存しない。認証隔離には公式の認証手順を使い、全設定・全履歴の複製を避ける。API keyへの暗黙の切り替えはしない。API利用は別課金の明示設定として分ける。

初期案は同時実行1、全体180秒、検索観測目標12回、input＋outputの目標20,000 tokens、候補最大6件。トークン・検索回数は現行SDKで厳密な上限を保証できないため目標と表記する。時間切れもremote課金の即時停止を保証しない。課金や実行結果が不明な場合、再起動後に自動再実行しない。Queue復旧方針は `interrupt` とする。

### 共通結果

結果は本文・claims・出典URL・資料名・短い抜粋・情報時点・取得時刻・確認方法・限界・実providerを持つ。株価には市場・通貨・価格種別・価格時点・遅延、天気には対象地点・予報対象時刻・発表時刻を追加する。取得時刻を発表時刻や価格時点の代わりにしない。

確認方法は `search_summary / source_read / snapshot_verified` を区別し、Lunaのsource_readはモデル申告と明示する。形式検証に通ったことを内容の真偽の保証とみなさない。resultは `completed / partial / failed / cancelled / interrupted` と終了理由を持ち、partialを完成キャッシュに入れない。

## 6 キャッシュの期限

キャッシュは取得を減らすための任意の層とする。最新性指定 `freshness=live` はEumenes内の永続・メモリキャッシュを迂回する。ただしproviderが返すデータ自体の遅延や更新頻度までは変更できない。

| 種類 | 再確認なしで利用できる期間 | 未使用削除までの期間 |
| --- | --- | --- |
| 天気・現在株価・最新ニュース一覧・検索一覧 | 保存しない | 対象外 |
| ニュース本文 | 毎回更新確認 | 3日 |
| 安定した資料本文 | 最大24時間 | 14日 |
| 時点依存の少ないLuna結果 | 最大24時間、根拠の期限以下 | 14日 |
| 最新性に依存するLuna結果 | 保存しない | 対象外 |

`freshUntil`は外部取得または正当な更新確認に基づく期限、`lastUsedAt`は要求への回答材料として実際に利用した時刻、`idleExpiresAt = lastUsedAt + idleTTL`とする。未使用で挿入された候補は挿入時刻からidleTTLを数える。

- 読み取りでfreshUntilを延ばさない。一覧表示、削除対象走査、存在確認、失敗した再取得はlastUsedAtを延ばさない。
- 鮮度期限切れは保存されていても通常の回答に使わない。未使用期限切れは掃除前でもmissとする。
- 記事のETag/Last-Modifiedによる確認は、元URL・表現条件・validatorが一致した場合だけ行う。304なら本文を再利用できる。対応しなければ再取得し、失敗したら「最新を確認できない」と返す。
- Cache-Controlのno-store、no-cache、max-age、Age、Varyとprovider契約を確認する。保存禁止は保存しない。再検証必須は毎回再検証し、アプリ側の24時間で延長しない。初版は認証付き・個人別Webページを共有キャッシュしない。
- Luna結果の期限は調査方針と根拠の利用期限の最小値。根拠の鮮度が不明な最新情報は保存対象外。LLMが勝手に長いTTLを設定できないようにする。
- providerやllm-fetch内のキャッシュも点検する。Eumenesでliveを指定したのに内部キャッシュが返る二重管理を防ぐ。

## 7 キャッシュキーと保存内容

初版は正規化した条件の完全一致のみで再利用する。利用者scope、操作種別、provider、接続設定revision、schema・抽出・ガードversion、地域・言語、対象日時・timezone、URLまたは質問、調査条件を含むcanonical JSONからkeyを生成する。Luna結果にはmodel、prompt version、必要情報・既知条件・探索範囲を含める。

「今日」「明日」は依頼時のAsia/Tokyo等の対象timezoneで絶対日付へ解決する。銘柄コードだけでなく市場・価格種別も識別する。URLのqueryを一律削除したり、条件が違う質問をLLMで同一と判定したりしない。hash化を秘密情報の保護手段とみなさず、会話全体・認証情報をkey素材やpayloadに含めない。

専用DBの `web_cache_entries` はkey、kind、scope、provider、各version、出典metadata、contentHash、fetchedAt、validatedAt、sourceUpdatedAt、freshUntil、lastUsedAt、idleExpiresAt、payloadBytes、etag、lastModified、generationを持つ。資料・調査メモのpayloadはメモリーパッケージが所有する同DB内のRecords等に一度だけ保存し、この行はそのID・revisionを参照する。最終schemaは第13章の契約確定で調整する。idleExpiresAtとlastUsedAtに削除用indexを設ける。保持期間の短縮時は既存行にも新しい上限を適用する。

保存するのはガード後の本文と正規化済みデータだけ。生HTML・script・cookie・認証header・provider生応答を保存しない。全件数とpayloadBytes合計を同一cache transactionで更新し、異常時に再計算できるようにする。

同じ条件で取得した新しい版は置き換え、全世代を蓄積しない。cache hitでも現在の送信許可、scope、version、期限を確認する。古いガードversionで許可された本文を無条件に再利用しない。

## 8 DBの分離と削除

再生成可能な本文は `data/cache/web-research.sqlite3` に置く。主DBと同様にbackend一プロセスがwriterを所有し、Web・CLIはAPIのみを使う。cache DBを失っても主DBの会話・正式保存資料を失わない。バックアップにはcache DBを含めない方針を文書化する。

主DBには `web_research_runs` と会話の採用記録を保存する。Queueに原文や大きな検索結果を埋め込まずrun IDを渡す。runの正規化済み一時結果は最大32 KiB・終端から14日、実行metadataは30日を初期保持期間とし、掃除する。正式に会話へ採用した回答・URL・必要最小限の引用は会話の保持規則に従う。本文の全量コピーや永続cache参照を会話の正本にしない。正式なレポート保存UIは後続であり、初版で全調査結果を無期限保存しない。

主DBのrun完了とQueue settleをtransactionで確定してから、cacheへbest-effortで保存する。途中結果を完成cacheとして先行公開しない。crashがこの間に起きた場合はcache missであり、外部調査を自動再実行する理由にはしない。

### 掃除と容量

- 起動時に期限切れを走査し、以降は稼働中1時間ごとに掃除する。保守処理はLLMを呼ばず、利用者の予約一覧へ追加しない。
- 1 transaction最大100件を初期値として分割し、各batch間で会話処理へ実行を譲る。重複起動しない。停止中は削除できないため次回起動で処理する。
- idle期限切れを先に削除する。未使用期限前でも、5,000件またはpayload合計128 MiBを超える挿入ではLRU順で削除する。1件最大1 MiBを初期値とし、超過結果は返してもcacheには保存しない。
- 同一transactionで削除・挿入・容量集計を行う。削除と利用が競合した場合は最新のlastUsedAtを条件に再確認する。書き込み混雑時はcache更新を諦めても、主処理を長時間待たせない。
- payload上限と実ファイルサイズは別である。DB・index・WALを計測し、初期案256 MiBを超えたら保存を停止して削除と容量回収を優先する。これを厳密なOSディスク上限とは表示しない。
- 新規cache DBではtable作成前にincremental auto-vacuumを設定し、空き領域回収とWAL checkpointを低負荷時に行う。既存主DBへ無断でVACUUMやpragma変更を適用しない。

現在のSqliteStore.writeはtransactionで包むため、transaction外で必要なcheckpoint等は専用のmaintenance入口でwriterと排他する。任意SQLを上位domainへ公開する変更にしない。cache DBの故障はcache無効として継続し、黙って主DBを削除・修復しない。

### 手動削除と遅れて返る結果

cache消去とcache generation更新を同じtransactionで行う。取得開始時にgenerationをcaptureし、古いgenerationの結果は書き戻さない。TTL変更、provider無効化、送信許可取消も有効なpolicy revisionで照合する。旧in-flightへの新しい要求の参加も拒否する。

共有取得では一人の待機者が取消しても他の待機者の取得を止めない。最後の待機者が消えたらAbortSignalで中断する。取消・旧generation・期限切れ結果は採用もcache公開もしない。cache削除は正式に保存した会話の削除ではなく、UIで範囲を説明する。

## 9 APIと設定の案

| API案 | 目的 |
| --- | --- |
| `POST /api/web-research/runs` | requestId、operation、型付き引数、freshness、必要情報を受け付け、run IDを返す |
| `GET /api/web-research/runs/:id` | 状態、結果、出典、取得時点、cache利用、実providerを取得 |
| `POST /api/web-research/runs/:id/cancel` | Queueと連携して取消 |
| `GET /api/web-research/cache/status` | 種類別件数、保存量、期限、最終掃除、異常状態を返す |
| `POST /api/web-research/cache/clear` | generation更新とcache消去。会話や設定は削除しない |

同じrequestId・同じ内容の再送は同一runを返す。異なる内容での再利用は409。期限切れ結果のGETは自動調査を起動せず、結果期限切れを返す。cacheや進捗の閲覧でlastUsedAtを更新しない。認証・Origin検証・request IDは既存APIに合わせる。

設定には軽量取得の有効化、各provider、Luna委任の有効化と実行上限、cache有効化、idle保持期間、件数・容量上限を追加する。「鮮度の高い情報は毎回取得」「使わなければ削除」を利用者向けの説明とする。無効なproviderを選択可能な機能として表示しない。秘密は既存settingsの暗号化・backend保管を使う。

実行時間・失敗種別・cache hit/miss・削除件数・payload量・観測tokenだけを集計し、ログに検索文、本文、正確な位置情報、認証情報を渡さない。cacheへの書き込みだけで会話全体のSSE再取得を発火させない。

## 10 実装工程

| 工程 | 作業と主な変更先 | 完了条件 |
| --- | --- | --- |
| P0 契約とprovider確認 | `web-research/contracts`、既存settings・inference契約調査、依存version・利用条件の確認 | operation/result schema、鮮度分類、天気・株価・ニュースの実providerと制約が確定。未提供は明記 |
| M0〜M2 メモリー本体 | 第13章の公開契約対応表、本体の不足機能・試験、配布物 | 既存Records等を再利用し、期限・忘却・調査メモの不足を解消した版を配布物単体で検証 |
| P1 軽量取得と実行基盤 | `web-research/service`、adapter、controller、主DBrun migration、Queue handler、`client/web-research.ts`、CLI、domain登録 | 明示APIからrunを作成・参照・取消できる。fixtureで検索・本文・天気・株価・ニュースを取得し、未設定・部分失敗・取消を区別 |
| P2 cacheと本体接続 | 検証済みmemory配布物、`web-research/repository`、cache adapter、SQLite maintenance、application起動・終了 | TTL/idle/LRU、世代、no-store、更新確認、重複排除、掃除、cache障害時の継続が通る。資料の保存・削除を本体公開操作で行う |
| P3 Luna | Luna adapter、P1のQueue handler拡張、専用資源枠・復旧方針 | 型付き結果、実行隔離、取消後不採用、再起動後の自動再実行防止。主DB保存後にcache公開 |
| P4 会話・調査メモと設定 | `dialogue`、`inference`の計画操作、本体の選択・再検証の接続、settings、Webの出典・進捗、CLI | 文字・音声で適切な経路選択。調査メモを予算内で利用し、背景調査が会話を塞がず、親revisionと根拠の有効性に従って採用 |
| P5 受入 | domain試験、全体検証、live検証と証跡 | fixture/live/実機器結果を分離し、品質・遅延・消費・cache効果を記録 |

P0で本体との契約を定め、M0〜M2とP1を進める。P1では必ず明示APIから動かし、自然文の経路選択と取得障害を分けて検証する。検証済み本体の取り込み後にP2を完了し、P2・P3を終えてからP4で自動委任と調査メモ利用を接続する。

主DB migrationは、`hostMigrations`への単純追記でvendor migrationの位置をずらさない。現行の展開済み `migrations` 配列を維持して、その末尾に追加する。適用済みDBからのupgradeと新規DBの両方を試験する。

## 11 検証と受入条件

### 外部サービスを使わない検証

| 検証対象 | 必須ケースと期待結果 |
| --- | --- |
| 鮮度優先 | 天気・株価・最新ニュースの連続依頼は完了後に再取得。同時依頼だけ共有。価格時点と取得時刻を混同しない |
| cache期限 | 読み取りでfreshUntilが延びない。利用でidle期限だけ延長。存在確認・status API・GCでは延長しない。期限境界を含めてfake clockで試験 |
| 更新確認 | 304、変更あり、validator不一致、no-store、no-cache、Vary、内部cache迂回。再検証失敗時に古い記事を最新として返さない |
| key | 地域、対象日、timezone、市場、通貨、調査条件、scope、versionの違いを混同しない |
| 削除と容量 | idle・LRU、並行利用、1件超過、容量集計復旧、起動時清掃、停止中経過、主DBを巻き込まない容量回収 |
| 競合 | shared取得の一部取消・全取消、cache clear直後の遅延応答、policy変更、旧generation、lease失効後の結果不採用 |
| 障害 | providerエラー、ガード拒否、rate limit、DB混雑、cache保存失敗、主DB保存失敗を区別。主DB失敗は完了表示しない |
| Luna | 構造化出力不正、根拠なし、検索要約だけ、時間切れ、usage不明、観測予算超過、SDK隔離、プロセス中断後の再起動 |
| 保持 | 一時結果14日・metadata30日の掃除、会話に採用した短い引用の独立性、cacheを丸ごと失っても通常会話が動く |
| 会話・音声 | 自動委任一回の上限、形式修復の上限、親revision変更、割込み、背景結果の重複採用防止、進捗の正本がbackendにある |

domain登録後に `bun run verify -- --domain web-research` を実行し、変更したsettings・inference・dialogue・voice-dialogue等の利用側domainも検証する。横断変更として `bun run verify:all` を完了させる。失敗が既存由来か今回由来かを分け、通っていない検証を成功と記録しない。

### Liveと実機器の受入

- 軽量取得は公開資料、国内ニュース、対象地域の天気、対象市場の価格で確認する。料金・遅延・利用制限は選定providerの契約条件で記録する。
- Lunaは短い事実確認、複数資料の比較、根拠不足の問いで確認する。普通の質問を全てLunaへ送らないこと、既存Codexチャットへ送信しないことも確認する。
- cache評価は安定した資料と同条件の調査でcold/warmを分ける。最新情報はhit率を目標にせず、古い情報を返さないことを優先する。
- 指標は外部取得数、Luna起動数、根拠を確認できた回答割合、終了までの時間、観測token、実provider費用、cache保存量。tokenからサブスクリプション残量を単純換算しない。
- 音声は実マイク・再生機器で3往復と調査中割込みを確認する。fixture成功だけで音声MVP完成を宣言しない。

検証記録は `spec/verification/web-research/` にfixture、live、devicesを分けて置く。記録には版、設定条件、結果、制約を残し、credentialやprovider生応答を入れない。全工程が終わるまでは「実装済み」「検証済み」「計画」を機能単位で区別する。

## 12 検索結果を回答LLMのメモリとして使う評価

追記日: 2026-10-09。以下は設計評価であり、実装済み機能を示すものではない。同日、利用者の範囲拡張により最小限の調査メモと必要なメモリー本体の変更を実装計画へ組み込んだ。本人記憶への自動登録は行わない。

### 判断

条件付きで採用を推奨する。特に同じ調査の続き、比較条件の追加、以前読んだ資料の説明には価値がある。保存した資料から必要な部分を回答時に取り出す外部メモリとして使う。モデルの重みが更新されたり、保存するだけでモデルが覚えたりする仕組みではない。

| 保持するもの | 回答への価値 | 推奨する扱い |
| --- | --- | --- |
| 検索結果一覧・snippet | 資料を探す手掛かり。省略や文脈欠落がある | 実行中の候補として使い、検証済みの知識には昇格させない |
| ガード後の本文・短い根拠抜粋 | 続きの質問や説明に再利用しやすい | 出典・版・情報時点・確認時刻を添えて期限内に利用 |
| Lunaの調査要約 | 複数資料の整理をやり直す回数を減らせる | 主張ごとの根拠、調査条件、未解決点を残す。要約そのものを一次資料扱いしない |
| 天気・現在株価・最新ニュース | 現在の事実としての再利用価値は低い | 最新回答は再取得。会話に採用済みの値は「その時点で何を説明したか」の履歴としてのみ参照 |
| ユーザーが示した好み・判断・制約 | 別の調査にも役立つ | 本人の発言を根拠に既存memoryへ保存。検索しただけで興味や信念と推定しない |

RAGは外部の資料を検索して生成に利用する方式であり、知識を要するQAに対する効果が報告されている。ただし本システムの節約率や回答品質を保証する結果ではない。[Lewisほかの原論文](https://arxiv.org/abs/2005.11401)

### 既存memoryとの分離

現在の `api/domains/memory/contracts/index.ts` はpreference・personal_fact・constraint・habitを扱い、`service/index.ts` はユーザーmessageからの一致引用を検証する。描画も「本人について保存された参照情報」である。Web上の事実をpersonal_factに押し込んだり、外部資料をuser_confirmedとして登録したりしない。

取得cacheは再取得の削減、調査メモは過去の調査条件と根拠の取り出し、既存の本人memoryは好み・制約という役割に分ける。この制限はEumenesの現在の接続に対するもので、本体ライブラリには既に外部取得物のRecordsとRecallがある。調査メモの業務方針はweb-researchが所有し、共通保存・選択・忘却は本体を利用する。dialogueはweb-researchの公開操作から取得し、既存の本人memoryからweb-researchへ依存を追加しない。ユーザー記憶のschemaやsystem roleへの挿入をそのまま流用しない。

### 推奨する最小構成

1. 完成した安定情報の調査から、質問・調査範囲・短い結論・主張ごとの出典と抜粋・未解決点・情報時点・確認時刻・確認方法を持つ調査メモを作る。新たなLLM要約呼び出しを毎回追加せず、元の調査の構造化結果を使う。最終回答の文章だけを記憶の正本にしない。
2. 最初は同じ会話の明示run参照、同じURL、同じ対象・版・期間などの構造化条件で候補を選び、P4で接続する。本体にあるRecallは必要な候補選択に再利用できるが、会話を横断した曖昧検索や新規embedding基盤は後続とする。既存索引の利用と、新しい検索基盤の開発は区別する。
3. 回答に渡す調査メモは初期案で最大3件・合計2,000 tokensを上限とし、0件も正常とする。採用モデルのtoken計測または安全側の上限を設ける。全文や全履歴を毎回入れず、関連性・根拠・鮮度を満たすものだけ選ぶ。
4. 外部由来の資料として、命令とは分離して渡す。資料内の操作依頼、ユーザー設定の変更要求、別サイトへの送信指示には従わない。格納時のガードだけで安全性が保証されたとは扱わない。
5. 最新性指定では以前の結論を現在の根拠にしない。期限切れメモを使う場合は、再取得すべきURL・未解決点など探索の手掛かりに限定し、現在の事実の根拠欄へ入れない。最新の根拠と矛盾した古い結論は無効化する。

メモの類似度は根拠の適用可能性とは別である。例えば同じ製品でもversion・地域・料金プランが違えば同じ結論を適用しない。将来検索を導入するときもscope・対象期間・版・状態を先に絞り、類似検索は候補選択だけに使う。類似した過去回答をそのまま返す変更にはしない。

### 保持・忘却

自動生成する調査メモはcache DBに置く再生成可能な派生物とし、出典cacheのID・revision・digestに依存させる。第6章の鮮度期限とidle期限を引き継ぎ、初期案の未使用14日を超えて別名で残さない。ニュース本文由来なら3日とする。派生物も128 MiB・5,000件の合計上限に含める。

根拠が保存禁止なら、要約・embedding・主DB一時結果へ移して保持制約を回避しない。第8章のrun結果についても、保持不可の本文やその代替となる内容は保存せず、許される実行metadataに限定する。

cache clearは調査メモと将来の索引も対象にする。元資料の削除・訂正・失効で依存するメモを削除または再利用不可にし、会話削除時にはその会話固有の質問・メモも削除する。保存済み会話の過去回答は会話の保持規則に従うが、そこから削除済みメモを自動再生成しない。

候補検索・一覧表示・回答に不採用となったメモはidle期限を延長しない。実際の回答採用が確定したメモと必要な根拠だけ利用時刻を更新する。採用前にscope、期限、出典revision、取消・削除generationを再確認する。別DB間の検査と主DB採用が競合しないよう、backendの直列化または主DB側の無効化revisionによる採用barrierを設計し、単なる別DBの直前readだけで取消安全とみなさない。

利用者が明示的に保存する資料集は将来の別機能とする。自動調査メモを固定化して未使用削除の対象外へ逃がさない。

### コストと品質の評価方法

節約が見込めるのは、Luna再起動、同じ資料の再取得、繰り返しの整理処理である。一方でメモの抽出・検索・回答への入力token・鮮度確認が増える。再利用が少ない利用状況や、毎回長いメモを渡す構成では費用が増え得る。サブスクリプション枠とAPI料金は別々に測り、合算tokenだけから金額や残量を換算しない。

評価は同じ一連の質問を、A: 保存なし、B: 取得cacheのみ、C: cache＋調査メモの3条件で比較する。初回取得から後続回答までの総量を含め、cold/warm、同じ会話/別会話、安定情報/更新後の情報を分ける。これによりcacheだけで得られる効果とメモ追加の効果を区別する。

必須ケースは、同じ比較の追加質問、条件・版の変更、翌日の天気と株価、情報の訂正、無関係な話題、検索snippetだけの主張、本文中の悪意ある指示、削除中の回答生成、親資料だけの削除、誤った要約からの自己引用である。生成済み回答やその要約を独立した裏付けとして数えない。

採用条件は、対象fixtureで古い情報の現在扱い・scope越境・削除後採用が0件、根拠適合性がBより悪化しないこと。そのうえで代表的な継続調査においてCがBよりLuna呼び出しや総入力量を削減するか、品質向上に見合う追加費用に収まることを測る。達成できなければcacheのみを維持する。実装時はweb-research・dialogueと変更した利用側のdomain検証、横断のverify:allを行い、liveでの効果はfixtureと別に記録する。

結論として、初版の鮮度優先cache方針を保ち、同じ調査の続きを支える小さな調査メモを実装対象に含める。全検索結果の永久保存や本人memoryへの自動混入は行わない。

## 13 メモリー本体を含む実装範囲

### 現状と変更の原則

本体の開発場所は `/Users/y.noguchi/Code/eumenes_memory`。確認時点でEumenesは `eumenes-memory` 0.3.3の固定tarballを使用し、manifestのDB schema版は4である。本体のREADMEには接続前の記述が残っているため、実装状況は公開ソース、採用manifest、Eumenesの接続コードと照合する。本体にも進行中の未コミット変更がある。実装前に両リポジトリの差分を確認して共存させる。

「別プロジェクトであるため変更できない」を制約にしない。必要な共通機能は本体へ実装し、Eumenes側で代替実装を積み上げない。一方、Web検索・Luna呼び出し・課金・ニュース等の鮮度分類はEumenesの責任に保つ。

| 本体で確認した既存機能 | 今回の再利用と不足確認 |
| --- | --- |
| Records: `captureRecord`、`readRecord`、`readRecordRange`、`recordSourceStates` | 外部本文の保存と出典参照を再利用。取得時刻・鮮度・idle・保持上限は現行入力にないため拡張対象 |
| Recall: `searchRecords` | scope限定の候補検索を再利用。現行検索は語のAND・更新順であり、意味的関連度検索とは扱わない。期限切れの除外をlimit適用前に組み込む |
| Temporal / Selection | 時間判定、予算内の選択、再検証を確認して流用。本人State中心の型にWeb知識を無理に変換せず、外部根拠を表す追加契約を設ける |
| Projection: View v1/v2と検証 | 既存利用者を壊さずに調査根拠用のview・再検証を追加する。必要なら別公開契約として版を付ける |
| Lifecycle: `planForget`、`applyForget`、journal、ExternalDependent、変更フィード | 資料・メモ・索引の依存を追跡して消す。元資料からメモへの依存、期限削除、復元時の再出現防止を検証する |

### 本体へ追加する機能

M0で既存公開APIとの対応表と契約例を確定し、次の不足だけをM1で実装する。関数名・型名はこの時点で確定する。既存の非Web用途の挙動は保持し、追加契約を未指定の既存Recordsへ一律14日削除を適用しない。

- **保持契約**: freshUntil、lastUsedAt、idleExpiresAt、最大保持量、保存可否、policy revisionを受ける。時計と具体的なTTLはホストが決める。期限の計算・判定、期限条件付き検索、採用時だけの利用更新を本体で統一する。
- **調査メモ契約**: 本人のStateと異なる種別・originで、要約、適用条件、未解決点、根拠のSourceRef集合、確認方法を保持する。根拠とメモの対応、矛盾・置換・期限切れを表し、単なる本文付きRecordsだけで検証済み知識と扱わない。
- **選択と採用契約**: 外部根拠の期限・scope・版・policyを含む固定viewと、その後の失効検証を提供する。既存Viewの互換性を維持し、host側が本人記憶と外部資料を別々に表示・注入できるようにする。
- **削除と容量契約**: 期限切れ・LRUによるevictと、明示的なforgetを区別する。evict後の明示再取得は可能とし、forgetの墓標や復元時の拒否をevict扱いで解除しない。削除対象の本文・全revision・メモ・索引・利用記録を追跡し、削除件数とbyte量を返す。

Recordsは現在、過去revisionの本文も保持する。今回の再生成可能なscopeでは不要な旧版を残さず、全版のbyte量を容量に含める。旧版を使うviewを有効なまま消さず、更新・削除の採用検証で棄却できるようにする。依存グラフ・削除記録・索引の増加にも上限または保持方針を設け、本文だけ減らしてDBが増え続ける状態を避ける。明示忘却の保護記録は容量都合で無効化しない。

### DBと接続の境界

別プロジェクトは別プロセスや別サービスを意味しない。本体は現在どおり純粋関数とホストから渡されたDBへの同期公開操作を提供する。接続、writer、transaction、PRAGMA、起動掃除、1時間ごとの実行はEumenesが所有する。本体からHTTP、Luna、Eumenes内部repositoryを呼ばない。

本人memoryは既存の主DBに残す。再生成可能な外部資料と調査メモは `data/cache/web-research.sqlite3` に置き、同DB内で本体の保存・削除APIを呼ぶ。資料の本文をcacheと主DB Recordsの両方へ複製しない。cache DB用にも公開schemaを正規に導入し、主DBのmigration配列や版番号を流用しない。接続・schema検査が複数DBで正しく動くことを本体consumer試験に含める。

cacheのSQLはEumenes所有の取得metadataと本体所有のRecords等に分ける。本体の内部tableへEumenesから直接書き込まない。主DBとの原子性が必要な採用・無効化はホストが直列化する。本人記憶のforgetからcache側に削除が必要な場合はExternalDependentとjournalを使って確認まで追跡し、未確認削除を完了扱いにしない。主DB・cache DBのどちらが失われても、残った側から忘れた情報が自動復活しない復旧順序を定義する。

### 工程と配布

| 工程 | 作業場所 | 完了条件 |
| --- | --- | --- |
| M0 対応表と契約 | 本体の `spec/`、contracts、Eumenesのadapter設計 | 再利用箇所と不足、責務、期限・削除・view例、DB境界が確定 |
| M1 共通機能 | 本体のrecords / recall / temporal / selection / projection / lifecycle、必要な公開型とmigration | fixtureで外部資料と本人Stateが分離され、保持・選択・忘却・採用の契約が通る |
| M2 配布検証 | 本体のconsumer試験、`artifacts/` | 全体検証とtarball単体のconsumer試験成功。版・SHA-256・契約版・schema版が確定 |
| P2/P4 接続 | Eumenesのvendor、memory公開利用層、web-research、dialogue、application | sourceへの直接importなしで外部メモを保存・選択・削除・再検証し、既存本人memoryが退行しない |

新版tarballを `vendor/eumenes-memory/` へ取り込み、manifest、package.json、bun.lockを同じ変更で更新する。同じ版のtarballを上書きしない。隣接checkoutなしでEumenesが復元できる状態を受入条件にする。更新前後のschema互換性を確認し、DB migration後の切戻しを依存ファイルの差戻しだけで可能とはみなさない。リモート公開はこの工程の必須条件ではない。

本体の正本設計・検証状況とEumenesの接続計画は各実装工程で更新する。今回は本書の範囲を拡張する段階であり、本体ソースや配布物は変更していない。

### 両プロジェクトの受入条件

本体で変更した各domainに `bun run verify -- --domain <name>`、最後に `bun run verify:all` を実行する。Eumenesではweb-research・memory・dialogueと変更した利用側を同様に検証し、`bun run verify:all`を完了する。現在のfixture件数を今回の検証結果として転記しない。

必須追加ケースは、既存本人memoryの互換性、Web由来情報の本人Stateへの混入防止、過去revisionを含む期限削除、期限切れ候補による検索枠の占有防止、検索だけではidle延長しないこと、evict後の再取得とforget後の拒否の差、親資料・会話の削除伝播、更新中と採用中の競合、旧DB復元・片方のDB欠落、二つのDBのschema更新、配布物だけを用いた起動である。公開回答・TTSは採用検証を通ってから行う。

試験不成功の版は取り込まず、失敗箇所を修正して対象検証を再実行する。機能を無効化して通常会話を継続できることは障害時の条件であり、今回の実装完了の代わりにはしない。第12章の費用・品質比較を行い、fixture、live、実機器の結果を分けて記録する。

## 14 参照

- [Eumenesのdomain入口](../docs/domains.md)
- [運用ログ](../docs/logging.md)
- [EumenesとMemorySystemの接続計画](memory-system-incremental-adoption-concept.md)
- [MemorySystemの実装計画](../../eumenes_memory/spec/implementation-plan.md)
- [MemorySystemの公開SQLite API](../../eumenes_memory/src/sqlite.ts)
- [ContextStillのCodex調査契約](/Users/y.noguchi/Code/contextStill/spec/docs/codex-research-contract-2026-10-04.html)
- [llm-fetchの公開API](/Users/y.noguchi/Code/llm-fetch/README.md)
- [HTTPキャッシュ RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html)
- [SQLite auto-vacuum](https://sqlite.org/pragma.html#pragma_auto_vacuum)
- [Codex Web検索の設定](https://learn.chatgpt.com/docs/config-file/config-basic#web-search-mode)
- [Codexの利用枠と料金](https://learn.chatgpt.com/docs/pricing)

外部仕様は2026-10-09の設計時確認を基準とする。SDK/CLIとproviderは実装時に採用版で再確認する。Firecrawlを含め、比較対象のコード移植や契約追加をこの計画の承認に含めない。


## 15 着手後の実装記録（2026-10-09）

今回の到達点は、明示依頼による検索・本文取得をAPI/CLIから利用し、安定した資料を期限付きで保存する初期実装である。会話LLMからの自動呼出しやLuna調査まで完了した段階ではない。

### 実装済み

- リリース済みnpmパッケージ `llm-fetch@0.1.2` を厳密固定して使用する。DuckDuckGo検索、最大5件の結果、指定時の最大3ページ取得、直接URL取得に対応する。ブラウザ描画は使用せず、HTTP安全取得と本文ガードをパッケージの公開APIに任せる。Tauriを起動するコードや依存は追加していない。
- `web-research` domainが取得台帳・正規化・キャッシュ方針を所有する。Queueのbackground枠と `web.fetch` 資源枠2件で実行する。取得全体は15秒、Queue依頼は30秒、再試行1回（初回のみ）。同一入力の実行中取得を共有し、片方の取消で他の依頼を止めない。取消・古いgenerationの結果を採用しない。
- APIは `POST /api/web-research/runs`、`GET /api/web-research/runs/:id`、`POST /api/web-research/runs/:id/cancel`、`GET /api/web-research/cache/status`、`POST /api/web-research/cache/clear`。認証・Origin検査は既存API共通処理を通す。client/CLIはAPIだけを使う。
- 入力は `lookup` と `read` に限定する。標準の取得は `live`、保存は `read` の `retention: stable` 明示時だけ。検索一覧の永続保存はしない。`live` はcacheを読まず新しく取得するが、stable指定時は新規取得結果で保存を更新できる。
- guard拒否・承認要求は失敗として返す。guardを無効化しての再取得はしない。出典URL・取得時刻・`untrusted`/`tainted`・本文確認と検索要約の区別・有限なguard理由コードを保持する。本文やProviderの生応答は運用ログに渡さない。
- 本文は文書ごと最大12,000文字、合計24,000 bytes、正規化結果全体32 KiB以内に制限する。初期段階では回答採用が未接続なので、結果受取用のメモリは最大64件・15分。第7章の一時結果14日保存案はこの段階では実装しない。GETは再取得を起こさず、期限切れは `resultExpired` で明示する。再起動でも受取用結果は失われる。
- キャッシュDBは主DBのディレクトリ配下 `cache/web-research.sqlite3`。本文はメモリーパッケージのRecordsに一度だけ保存し、ホストにはキー対応とgenerationだけを置く。主DBの確定後にbest-effortで保存し、保存失敗で完了済み依頼を失敗に変えない。
- 安定資料のfresh上限24時間・idle14日、合計5,000件/128 MiB、単一1 MiB、DB/WAL/SHM合計256 MiB超で新規保存を停止する。idle削除は起動時と1時間ごと、1 transaction最大100件。LRU削除、checkpoint、incremental vacuumを行う。キャッシュの全削除はgenerationを進め、実行中だった取得が後から復元しない。
- HTTP `no-store`、`no-cache`、`private`、Cookie、Vary、WWW-Authenticateを持つページは保存対象外。`max-age`・`Age`・`Date`・`Expires`で再利用期限を短縮する。304再検証はまだ実装せず、再検証が必要なページは再利用しない。
- 別プロジェクト `../eumenes_memory` にretention v1とmigration 0005を追加した。公開操作は `retainRecord`、`readRetainedRecord`、`useRetainedRecord`、`retainedRecordStats`、`evictRetainedRecords`。読取だけで期限を延長せず、確定後の利用通知でidleだけ延長する。新規本文への置換では過去revision・本文・FTSを剪定する。既存の通常Recordsを自動削除対象に変更しない。evictはforget墓標を消さず、依存する永続Stateがある資料の削除を止める。
- メモリーの配布候補はvendor `eumenes-memory-0.3.4.tgz`、schema 5。SHA-256、依存指定、lockfile、インストール済み版の整合を検査する。これはローカル配布候補でありnpm公開はしていない。既存のmemoryプロジェクトの作業中変更は保持し、その作業ツリーを元にパックした。

### 検証

- fixture: Web取得domain 10件、CLIプロセス6件、migration/SQLite writer 8件が成功。期限境界、アクセス時のfresh不延長、実行共有と個別取消、削除中取得の棄却、主DB確定失敗時の非公開、HTTP保持規則、容量一杯での同一キー更新を確認した。
- Eumenes `bun run verify:all`: backend 306件、Web 92件、ブラウザfixture 14件の計412件成功。format/lint/型/境界/画面buildを含む。ローカルの `.claude/` 設定で全体format検査が停止したため、このGit管理外ディレクトリをformatter対象外に加えた。設定内容は変更していない。
- メモリープロジェクト `bun run verify:all`: 1,610件成功。公開面・型・境界・互換性・evalを含む。retention公開APIの消費者試験5件を含む。
- live: インストール済みnpm版を使い `https://example.com/` の本文156文字を取得（guard `allow`）。`https://bun.sh/docs/runtime/sqlite` は `GUARD_DENIED` / `require_approval` で本文を返さなかった。これは拒否の観測であり、全サイトを取得できることや原因が誤検知であることを証明しない。
- 実機器の音声受入は今回の検証対象外。

### 未実装と次の工程

P1の天気・株価専用API、ニュース/RSS・記事再検証、会話の取得計画と結果採用、P3のLuna起動・調査結果保存、P4の設定・出典UI、M1/M2の調査メモ・派生資料選択・利用時の依存検証を残す。保存されたRecordsはまだ回答LLMへRecall経由で自動提供しない。外部知識をユーザー個人のStateに変換する処理も追加していない。

## 16 コードレビューと修正記録（2026-10-09）

第15章の初期実装を対象に、Web取得・キャッシュ・Queue確定・API/CLI・メモリー公開操作・配布物を再レビューした。問題を再現する試験を追加して修正し、再レビューで同じ条件と周辺の競合を確認した。今回確認した範囲では、残る具体的な不具合の指摘はない。第15章の件数と配布版は初期実装時の記録として残す。

### 修正した問題

- **鮮度と更新**: Expiresの期限計算で上流Age、サーバーDate、通信時間、ガード処理時間を反映する。ヘッダー名の大小文字を正規化し、重複・不正値は再利用しない。新しい応答が保存不可なら、同じキーの古い本文もキャッシュから外す。リダイレクト途中の保存方針を確認できない応答、206の部分本文は保存しない。計算の基準は [RFC 9111 §4.2.3](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.2.3)。
- **競合と削除**: stable指定の同じURLは、liveでの取得も含めて直列化し、遅い旧結果による上書きを防ぐ。URLのfragment違いは同じHTTP資料のキーとして扱う。キャッシュ全削除が無関係な検索を失敗させないようにし、保存先が使えない場合や永続依存により削除できない場合には成功と返さない。
- **確定と資源解放**: 主DBとQueueの確定を確認してから結果を公開する。rollbackした結果が既存の受取用結果を追い出さない。取得側が中断通知を無視しても15秒の期限でQueue資源を解放し、後から返った結果は採用しない。掃除・全削除・終了処理の競合を待ち合わせ、一方の終了失敗でも他方のDBを閉じる。
- **結果とCLI**: JSONエスケープ分も含めた結果サイズ制限で本文を切り詰め、正常取得をサイズ超過の失敗に変えない。Unicodeタイトルの制限でサロゲートを分断しない。ガードの承認要求と拒否を区別する。CLIの通信・待機・取消確認を期限付きにし、取消や受取結果の消失を成功扱いにしない。
- **メモリー保持契約**: 権限確認を存在判定より先に行い、未知の入力キーやgetter付き入力を受け付けない。永続Stateや外部Providerへの出典依存がある本文は、更新時の旧版剪定やevictでも保護する。忘却したRecordsの保持metadataをmigration 0006とtriggerで除去し、墓標は維持する。同時刻のLRUで新規資料を優先して消さないようにし、削除不可の古い資料が他の削除対象を塞がないようにする。
- **互換性**: 旧配布版からのmigration試験で実際の会話データを保存してから更新し、更新後も本文が残ることを確認する。APIの認証・Origin・不正JSON・保存先不在の試験を追加した。

### 配布と検証

メモリーの修正版はローカル配布候補 `eumenes-memory-0.3.6.tgz`、schema 6として接続した。旧版tarballは上書きせず、manifestのSHA-256、package.json、bun.lock、インストール済み版を一致させた。npmへの公開は行っていない。

- fixture: Web取得domain 26件、CLIプロセス9件を含め、追加した再現・回帰試験が成功。
- メモリープロジェクト `bun run verify:all`: 1,617件成功、0件失敗。retentionの公開消費者試験12件、型・format・lint・境界・互換性・eval・公開面の検証を含む。
- Eumenes `bun run verify:all`: backend 326件、Web 92件、ブラウザfixture 14件、計432件成功、0件失敗。format・lint・型・domain境界・画面buildを含む。取り込んだ0.3.6の配布物で確認した。
- このレビューではlive取得と実機器の音声受入を追加実施していない。Luna、会話LLMへの自動接続、調査メモなど第15章の未実装範囲は変わらない。

## 17 Toolchain接続（2026-10-09）

第15・16章の未実装欄は当時の記録として残す。今回、会話からの能力選択、プロフィールとSKILLを持つ調査担当の起動、Web取得、根拠付き要約、会話への回答採用、出典cardを接続した。子はメインへ本文を転送しない。専用の公開JSON読取りを天気・明示tickerの株価に追加し、既存Web domainのguard・Queue・結果契約を通す。

Luna専用Providerを新規接続したものではなく、既存のLARM LLMを制御modeで使う。通常会話の最終回答には従来のinference経路を使う。取得結果の原文は短期メモリー、検査済み要約はagent-runtimeに14日保持する。M1/M2の調査メモ、派生資料選択、RecordsのRecall自動提供は今回も未実装。詳細と試験結果は[Toolchain実装記録](verification/toolchain/README.md)を参照する。
