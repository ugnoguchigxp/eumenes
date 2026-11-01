# 同じ会話のメイン接続再利用・無操作中の増殖修正

2026-11-01。対象は[修正計画](../../larm-main-reuse-fix-2026-11-01.md)。既存の会話・エージェント管理情報と接続leaseを再利用する調整であり、LLMの判断、経路選択、Provider選択の優先順位は変えていない。

## 修正

- prewarm、agency、stewardから会話メインのagentSessionを明示する。会話本文・connection IDから所有者を復元しない。所有者を欠くmain/onConversationは接続作成前に拒否する。
- managed portの初期connect/probeと画面保持では匿名の共有LLMを確保しない。会話・agentごとのメイン接続を再利用する。
- 音声scopeはcatalogの非LLM Providerをすべて保持し、重複したLLM Allocationを作らない。独立auxiliary接続は完了時、subagent接続は既存のtask終了時に解放する。処理中は自然終了を待つ。
- ready接続のclaimable cacheが失効した場合は既存のProvider health APIで再確認し、GET応答のclaimableと容量の検査を通してからclaimする。生成POSTの無条件再送、200kへのサブ昇格、内部生成ヘッダーは追加しない。

## 固定試験・結合試験

`bun run verify -- --domain larm --domain inference --domain dialogue --domain steward --domain voice-dialogue --domain agent-runtime --domain tool-runtime`

- backend 242ファイル1,741件、Web 15ファイル95件が成功。境界、system-context、サイズ、SQL境界、整形、lint、型検査、DesignSystemの検査・buildも成功。
- [verify-report.json](verify-report.json): 09:42:12〜09:45:16 JST、result=pass。source revisionは`dce0c7cc11231de058044064ffd1cd6dcf89a6a08d5c564b06c7640e3c5af4b8`、開始・終了で一致。選択外のdocs/domains.md生成表の不一致は警告として記録し、変更しない。
- 一括試験後、追加2試験の手動時計を除いてBunの仮想時計だけで正確に20分進める形へ整理し、対象7ファイル48件がすべて成功。製品コードは一括試験時から変更していない。最終型検査2,785ファイル・変更した試験のlint/整形・差分の空白検査も成功。
- 実inferenceと自動prewarmの結合で、初期probeは0本、会話メイン・5回以上の先読み・20分の更新・継続SSEは200kの同じconnection ID/cache keyを使用。隠れた画面の保持・renewでも新しい接続を作らず、credentialを更新する。Profile保持POSTの反復回数と、返された一意のconnection ID数は区別する。
- 既存容量試験で別会話・agent・履歴分岐の分離、Bearerの正しい対応、main1＋sub2の同時実行と追加待機、renew・epoch変更・idle release後の再作成、通常JSON/SSE、未知の生成結果の非再送を確認。
- 独立auxiliaryの反復後は保持表0件、task終了はそのsub接続だけを解放。処理中の解放要求は生成を中断せず終了を待つ。
- managed portでmain200000＋sub131072を使いながら、ASR・日本語TTS・英語TTS・態度判定が成功。音声scopeの要求は全非LLM Providerを含み、LLMを含まない。診断試験でcredential/cache key/本文の非出力を確認。
- ブラウザー操作や再生経路を変更していないため、ブラウザーE2Eは省略。音声機器の3往復受入は今回の固定試験に含めない。

## 実LARM（隔離したlibrary呼出し）

09:43:33 JST、保存済み設定をsettings domainの読み取り専用操作で取得。稼働backend・製品DB・設定は変更していない。[live-report.json](live-report.json)を参照。

- 初期connectで作成0本。メインは`providers:["llm"]`、`contextTokens:200000`で作成し、実LARMが返したIDを使用。ただしpendingのまま10秒の呼出し期限に達し、生成成功には数えない。稼働旧backendは09:42のAPIでconversationId=nullのmain200000を3本保持していた。先の調査で同じ増殖によるruntime_capacity待ちを確認している。
- 音声scopeの要求はasr/embedding/system-one/tts/tts-englishでLLMなし。準備159ms、音声認識123ms、音声合成301ms（61,996 bytes）で成功。入力はリポジトリの試験用WAV。本文・Providerの生応答・credentialは報告に保存していない。音は再生していない。
- 隔離試験の2接続はclose後のGETでいずれもreleasedを確認した。既存の他接続は解放していない。

## 稼働反映・残作業

実装と固定試験は完了。稼働中のbackendは修正前のままであり、この結果を配備完了とはしない。サーバーの停止・起動・再起動にはAGENTS.mdの明示許可が必要なため実施していない。

反映後に、旧匿名接続の自然失効または許可を得た整理を確認し、実会話メインの会話ID/agent IDと200k、同じIDでの先読み・継続、sub128kの生成を再確認する。音声のlibrary接続確認と、利用者のブラウザーでの実機器受入は区別する。

担当外のcapacity待機・メディア・UI等の差分を点検し、保持した。今回の変更は管理ID、容量契約、接続寿命の強制に限り、語句による分類・固定応答・モデル/Profile名の製品コードへの追加はない。
