# LARM Ruri 埋め込みと索引の移行設計

2026-11-21。利用者の指示により、旧ベクトルは削除可能とし、既存の保存形式を使う範囲で実装する。

担当検索と会話記憶の類似検索を、保存済み LARM 接続先が提供する Ruri の埋め込み規格に揃える。担当の登録、検索の候補枠、会話 LLM による依頼の解釈と担当の選択は、[会話から担当を選ぶ設計](conversation-first-toolchain-2026-11-21.md) と [担当検索の設計](toolchain-search-choice-design-2026-10-30.md) に従う。埋め込みは既存の担当を横断する内部機能なので、現在の bundle・adapter と `find_toolchain` を再利用する。

## Provider の接続と推論

1. settings domain の保存済み Control origin・Profile・audience と、backend の既存 Control 認証を使う。通常 Profile の catalog にある `name: embedding` の Provider を特定する。通常 Profile の非 LLM 接続に embedding が含まれていれば、既存の lease から借りる。Provider を限定する接続では、必要な接続スコープの一覧に embedding を含める。埋め込みだけから音声や LLM の確保を要求しない。
2. 共用できる接続が無い場合は、埋め込み専用の lease を `embeddingCanary` で取得する。内部 Profile ID が `contextstill-embedding` で、Provider の protocol が `larm.embedding.v1`、公開 model が `ruri-v3-130m` であることを検査する。作成は catalog revision、設定済み audience、`providers: ["embedding"]`、`ttlSeconds: 300`、`allowFallback: false`、`deploymentPolicy: "existing-only"` と UUID の Idempotency-Key を使う。`same-host` は同一ホストの設定時だけ許す。201・202 から ready まで既存の準備待ちを使う。
3. ready 後に `format: "larm-embedding-provider-v1"` と `providers: ["embedding"]` で claim する。claim に Idempotency-Key は付けない。応答から名前で Provider を選び、既存の URL 検証を通した公開 endpoint と Provider の bearer を使う。Control 認証は管理 API 内に留める。
4. 共有接続の renew は既存の所有者に任せ、更新後は各 Provider を利用時にそれぞれの format で再 claim する。世代の異なる資格情報を並行操作へ渡さない。専用接続は同じ更新・解放処理を使い、300秒の lease を期限前に延長する。設定変更、終了、不要になった専用 lease は既存の drain・release に従う。資格情報はメモリ内だけで扱う。
5. 平文を `texts` として送り、検索文は `query`、索引の文は `passage` を指定する。両方とも `normalize: true`、`priority: "normal"` とする。接頭辞とトークン処理は LARM が担う。応答の要求 type、件数、512次元、各要素の有限性、L2 norm の1との差（許容値 0.001）を確認する。
6. 同じ backend の embedding 利用を既存の実行制御で直列化する。実行1件、待機32件、待ち時間と再試行を含め1要求30秒以内とし、元の呼出しが短い期限を持つ場合はそれに従う。1–64件と本文量の両方で batch を制限し、再索引は batch 単位で実行枠を返す。長い本文は既存の Markdown 分割の1600 UTF-16単位・サロゲート境界の処理を、本文を失わず列挙できる形で共用する。既存呼出し側の用途別テキスト組立てを保ち、索引中の長い passage は末尾まで全チャンクを保存する。
7. 400 は再送せず要求エラーとする。401 は既存の接続・期限の確認から再 claim または再接続に進み、再試行は1回までとする。409 は公開エラーコードで catalog 更新、既存接続の解放、その他の競合を区別する。catalog revision の競合は取得し直した revision で1回だけやり直す。一時障害は既存の再送判定を使い、Retry-After があれば待ち、期限に収まる範囲で最大2回再試行する。失敗と取消は検索の結果0件と区別する。既存の全文検索を許している経路では、埋め込みが使えなかったことと全文検索の結果を呼出し元に伝える。

固定するモデルの元は `cl-nagoya/ruri-v3-130m`、revision は `e3114c6ee10dbab8b4b235fbc6dcf9dd4d5ac1a6`。LARM が指定する ONNX FP32、非量子化、attention mask 付き平均、L2、SentencePiece Unigram、接頭辞・特殊トークン込み8192 tokens、末尾切り詰めの契約を使う。接頭辞は `検索クエリ: ` と `検索文書: `。末尾には半角空白を含む。catalog の宣言を照合し、モデル artifact と tokenizer の digest を含む `embeddingSpace` の JSON 全体を保存する。

## 索引の棚卸し

| 保存先 | 現行の用途 | 再生成する入力 |
| --- | --- | --- |
| `capability_toolchain_vectors` | 有効な担当・パイプライン・組込みの読むツールの候補検索。担当ごとに最も近い passage のスコアを使う | 公開 revision の `title: summary`、`useWhen`、`examples`。現在の順序を保ち、各文を passage とする |
| `memory_turn_vector` | Steward が過去の会話を類似検索し、表示済み文や忘却済み文を除いて交換単位で返す。旧テーブルは message ID ごとに1ベクトル | 旧索引と同じ対象範囲の、現在も参照できる会話メッセージの本文。長文は全チャンクを保持し、メッセージの最高スコアで既存の交換単位に集約する |
| `toolchain_selections` の query vector | 過去の選択の参照と、担当検索の順位の再計測。現在の担当候補の類似度は過去の選択で補正しない | 今後の query は新しい space で保存する。保存済みの委任向け依頼文は入力が異なるため、過去の検索の query は既存の診断記録として扱う |
| `toolchain_recipe_vectors` | 保存済み手順の署名。現行の会話からベクトル検索への呼出しはない | 手順の署名と旧ベクトルを保持する |
| 旧 Router のカード・trace・評価資産 | 旧来の自動判断の履歴と比較。通常会話からの接続を撤去済みの方針 | 当時の記録を保持する |

Markdown、Docling、Web 資料の現在の読取り・全文検索には、この埋め込み索引への参照がない。実装に入る対象は現在の類似検索と担当検索。ベンチマーク用のローカルモデルは製品の経路に含めない。

## 再生成と切り替え

- 既存の `space` 列に、完全な `embeddingSpace`、テキスト組立て版、チャンク方式版をプロパティ順が安定した JSON で記録する。検索はこの値が一致する行を使う。384次元、生成条件不明の512次元、接頭辞・tokenizer 等が異なるものは別の索引として扱われる。
- 担当は既存の更新処理で新しい `space` の索引を別に組み、更新した passage が揃ったことを単一 writer の transaction で確認してから公開する。space が変わった途中 batch の結果や、取得時から改訂・失効した担当の結果は採用しない。
- 会話記憶は既存の `vector` 列へ同一メッセージのチャンクを連結して保存する。既存の索引対象を metadata が合うものへ順次置き換える。現在有効な本文と digest を確認してから書き込み、既存の忘却・取消処理で消した行を復活させない。Ruri で計算できた行だけを新しい query で検索する。
- 原文は再生成できるよう既存の保存先で扱う。配備済みの両 Profile が Ruri を広告しているため、移行前に戻す場合も現在の接続で旧 E5 索引が使えるとは扱わない。

## 検証と完了条件

1. **部分試験**。Provider fixture で 201・202、ready 待ち、名前での claim、未知の追加 metadata の保持、応答検査、400・401・409・Retry-After・待機中の期限と取消を確認する。更新と再 claim の競合、共有中の音声・判断の利用、解放後の失効を確認する。索引 fixture で同じ次元の別 space、途中再生成、元データ更新・忘却、長文の末尾を確認する。
2. **結合試験**。隔離 SQLite に旧レコードを残したまま、通常の起動時 seed と公開済み担当で、新世代の件数と切り替え前後の検索を比較する。 `bun run verify -- --domain <name>` で `larm`、`capabilities`、`memory`、`toolchain-history` と影響のある `dialogue`・`steward`・`inference` を確認し、対象の application 試験をファイル指定で実行する。
3. **配備済み LARM と実検索**。指定の接続を通る実 embedding で、登録された担当を索引化し、通常の `find_toolchain` に日本語の依頼を渡す。件数と retrieval が embedding であること、意図した担当の順位・候補入りを記録する。例文の丸写しを避け、似た担当が同時に有効な状態で試す。下表の明確な依頼は期待先が1位。会話から委任へ進む経路も、実際の変更を伴わない隔離試験で選ばれた担当を確認する。日本語の文書検索は、異なる題材の passage と長い文書の後半を含めて確認する。

| 日本語の依頼 | 期待する担当 |
| --- | --- |
| 25分計って、時間になったら知らせて | `timers.manage` |
| 明日の横浜、朝は傘を持って出たほうがいい？ | `weather.forecast` |
| 夜の読書に合う、歌のない曲を新しく一曲作って | `music.create` |
| 前に保存した曲を一覧から探して聴きたい | `music.library` |
| 紅葉の公園を描いたイラストを一枚作って | `image.create` |

## 実装前に確認した事実

- 保存済み Profile と `embeddingCanary` の catalog が HTTP 200 を返した。両方の `embeddingSpace` は一致し、公開モデル・元モデル・revision・512次元・接頭辞・L2・SentencePiece Unigram・8192 tokens・末尾切り詰め・mean を確認した。artifact と tokenizer の digest が存在した。ONNX の実体は接続契約の範囲にある。
- canary の検証用専用接続で create → ready → claim → 日本語2件の query と passage を実行した。入力を逆順にした再計算で出力順を確認し、正しい passage が2問とも1位だった。件数・type・512次元・有限値は一致し、L2 norm の1との差は最大約 `2.05e-7`。renew 後は新しい資格情報で200、旧資格情報で401。release は204で、解放した資格情報による推論は401だった。
- 現行の LARM 接続管理と担当候補の固定試験4ファイルは51件通過した。初回の相対パス指定では保存済みスナップショットも選ばれたため、現行ファイルの絶対パス指定で再実行した。

検索順位に関わる候補枠と閾値は現行設計で試験し、実測で要件を満たさない場合は結果を記録して調整を協議する。

## 実装後の確認

- 既存の `space` と `vector` を使った。新しい保存列・migration はない。384次元、生成条件不明の512次元、tokenizer digest が異なる索引が同時にあっても新規の検索に使われないことを固定試験で確認した。途中で space が変わった再索引は公開せず、会話記憶の長文は末尾を含む元の本文から再生成できた。
- LARM の固定試験で、ready 待ち、名前での claim、401 の再 claim、renew 後の資格情報、期限付きの再試行と解放を確認した。同じ非 LLM 接続で ASR・両 TTS・態度判定・embedding を使い、別に取得した主・補助 LLM の接続でも生成できた。
- `bun scripts/toolchain-embedding-live.ts --live` は隔離 DB に148 passage を登録した。表の日本語5件は通常の `find_toolchain` の候補で全て1位、検索方式も全て `embedding` だった。会話モデルは検索を呼ぶ固定応答、ベクトルは配備済み LARM の実応答を使った。初回は天気の試験用地域一覧が空で可用性の条件を満たさず、既存の地域 fixture を読み込んで同じケースを再確認した。
- `verify` の LARM・capabilities・memory・Markdown・toolchain-history 指定では、境界、型、lint と DesignSystem ビルドが通過した。結合を含む Bun 試験は1108件通過し、バックアップ試験の依存未導入、起動停止の既存期待値、作曲試験の既存ツール定義参照で計3件が失敗した。対象を dialogue・steward・inference に広げた実行は既存の Codex transport 関数の行数制限で停止した。別途実行した既存の天気結合試験には Router 前提の失敗4件が残った。
- 2026-11-21 利用者確認。今回の対応範囲はコード変更と隔離環境での検証まで。
