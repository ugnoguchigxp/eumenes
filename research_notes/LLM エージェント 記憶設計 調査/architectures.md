# LLM 会話エージェントの記憶アーキテクチャ比較（書く・いつ・誰が・どう読む）

調査日: 2026-11-22。凡例: 「(本セッションで原典確認)」= 今回 WebFetch で一次資料本文/要旨を読んで確認。「(未確認)」= 記憶・二次情報に基づき、今回一次資料で確かめられなかったもの。

## Q1. 各方式は何を・誰が・いつ書き、どう読み、矛盾をどう扱うか

### Takeaway
書き手は大きく3系統に分かれる。(a) 会話モデル自身が tool で書く（MemGPT/Letta、ChatGPT/Claude の明示保存）、(b) 別の抽出 LLM がターン毎に書く（Mem0、Zep/Graphiti、A-MEM、Generative Agents の観察）、(c) 背景処理が後でまとめる（Generative Agents の reflection、LangMem background、Letta sleep-time/dreaming、Mem0 の要約更新）。読み出しは「常時注入」（core memory / profile / 要約）と「毎ターン検索注入」（Mem0, Zep）と「モデルが tool で検索」（MemGPT archival/recall, Claude chat search）の3系統。矛盾処理は「削除/上書き」（Mem0 DELETE/UPDATE、A-MEM evolution）と「無効化して履歴保持」（Mem0g invalid 印、Zep bi-temporal t_invalid）に分かれる。

### Cited Findings

#### MemGPT / Letta（2023-10, v2 2024-02）
- main context（プロンプト内）を3区画に分ける: 読み取り専用の system instructions、固定長で読み書き可能な working context、メッセージ・system alert・関数入出力の FIFO queue。FIFO の先頭スロットには追い出したメッセージの再帰要約が入る（本セッションで原典確認）— [MemGPT paper v2](https://arxiv.org/html/2310.08560v2)
- external context は2種類。recall storage は queue manager が全メッセージと LLM 出力を書くメッセージ DB で、追い出し後も検索できる。archival storage は任意長テキストの読み書き DB（文書 QA 設定では PostgreSQL+pgvector、HNSW）— [MemGPT paper v2](https://arxiv.org/html/2310.08560v2)
- 書き手は会話 LLM 自身で、自己編集の memory 関数で working context を編集し、archival/recall を検索・挿入する。論文本文は関数名を明示しない。Letta 実装の `core_memory_append` / `core_memory_replace` / `archival_memory_insert` / `archival_memory_search` / `conversation_search` は（未確認）— [MemGPT paper v2](https://arxiv.org/html/2310.08560v2)
- 書くタイミングはメモリ圧で決まる。warning token count（例: context の70%）で memory pressure の system message を出して LLM に退避を促し、flush token count（例: 100%）で queue manager が一定割合（例: 50%）を追い出して再帰要約を更新する — [MemGPT paper v2](https://arxiv.org/html/2310.08560v2)
- 制御はイベント駆動（ユーザー発言・system alert・定時タイマー）。`request_heartbeat=true` で関数呼び出し直後に再推論して関数を連鎖でき、検索結果はページングされる — [MemGPT paper v2](https://arxiv.org/html/2310.08560v2)
- MSC の deep memory retrieval の正答率は GPT-3.5 Turbo 38.7%→66.9%、GPT-4 32.1%→92.5%、GPT-4 Turbo 35.3%→93.4% — [MemGPT paper v2](https://arxiv.org/html/2310.08560v2)
- 弱点: GPT-3.5 は function calling が弱く劣化した。検索結果を最後までページングせずに打ち切ることが多い。embedding 検索が正解文書を下位に置き、性能の上限になった — [MemGPT paper v2](https://arxiv.org/html/2310.08560v2)
- Letta の現行 docs（日付記載なし、2026時点）では "dreaming" という背景 subagent が最近の会話を見直し、教訓を統合して記憶を更新する。実行は一定数の agent step 完了後か、context の compaction 時。オプションの "Agent reviews before applying" で提案された更新を別の背景会話で見直す。記憶は MemFS（git-backed filesystem）に置かれ会話間で共有される（Free 5 MiB / Pro 50 MiB）— [Letta docs](https://docs.letta.com/guides/agents/architectures/sleeptime)
- 旧来の Letta "sleep-time agent"（primary agent と記憶ブロックを共有する別 agent が非同期に core memory を書き換える設計）の詳細は現行 docs から消えていて確認できなかった（未確認）— [Letta docs](https://docs.letta.com/guides/agents/architectures/sleeptime)
- 関連論文 Sleep-time Compute（2025-04、著者に Packer/Wooders、コードは letta-ai）: クエリ前に文脈をオフラインで「考え」、予測できる質問の中間結果を前計算する。同じ精度に要る test-time compute が約1/5になり、精度は Stateful GSM-Symbolic で最大+13%、Stateful AIME で最大+18%。関連クエリで償却するとクエリあたり費用は1/2.5。効果はクエリの予測しやすさと相関する — [arXiv 2504.13171](https://arxiv.org/abs/2504.13171)

#### Generative Agents（2023-04, v2 2023-08）
- 経験を自然言語で完全に記録し、時間をかけて上位の reflection に合成し、動的に検索して行動計画に使う。25 agent の sandbox で評価し、ablation では observation・planning・reflection のそれぞれが believability に大きく寄与した（本セッションで原典確認・要旨）— [arXiv 2304.03442](https://arxiv.org/abs/2304.03442)
- 以下の数値は論文本文の記憶に基づく（未確認: 今回 PDF は取得サイズ超過で読めなかった） — [arXiv 2304.03442](https://arxiv.org/abs/2304.03442)
  - 検索スコアは recency・importance・relevance を min-max 正規化した加重和で、重み α は全て1。recency は最終アクセスからの sandbox 時間あたり減衰係数 0.995 の指数減衰。importance は書き込み時に LLM が1〜10で採点。relevance は query embedding との cosine。
  - reflection は直近イベントの importance 合計が閾値150を超えると起動する（1日2〜3回）。直近100件から「顕著な質問」3つを作り、検索した記憶から根拠付きの洞察5つを生成して memory stream に書き戻すので、reflection の reflection（木構造）ができる。
  - 失敗例として、関連記憶の検索漏れ、記憶への脚色（hallucinated embellishment）、過度に丁寧な口調が報告された。

#### MemoryBank / SiliconFriend（2023-05）
- 以下は論文記憶に基づく（未確認: 今回再取得せず）— [arXiv 2305.10250](https://arxiv.org/abs/2305.10250)
  - 保存するものは3層: 会話ログ、日次イベント要約から作るグローバル要約、user portrait（性格・嗜好の要約）。書き手は別の要約 LLM で、日/セッション単位に書く。
  - 忘却は Ebbinghaus 曲線 R = e^(−t/S) に従う。記憶が想起されると強度 S を+1し、経過時間 t を0に戻す。
  - 読み出しは FAISS による dense 検索で、portrait と要約はプロンプトに注入する。
- 第三者の A-MEM 論文の LoCoMo 比較（GPT-4o-mini）で MemoryBank は Multi-hop F1 5.00、Temporal F1 9.68、平均使用トークン432と極端に低かった — [A-MEM paper](https://arxiv.org/html/2502.12110)

#### A-MEM（2025-02）
- 記憶 note は7項目: 原文 c、timestamp t、LLM 生成の keywords K・tags G・文脈説明 X、embedding e（c+K+G+X を all-MiniLM-L6-v2 で埋め込む）、リンク集合 L（本セッションで原典確認）— [A-MEM paper](https://arxiv.org/html/2502.12110)
- 書き込み1回で3段の LLM 処理が走る: ① note 構築（keywords/tags を最低3つずつ）、② link 生成（cosine top-k 候補、既定 k=10、から LLM がリンクを選ぶ）、③ memory evolution（候補の各隣接 note について、LLM が context/tags を書き換えた版で元 note を置き換える。strengthen/merge/prune 相当）— [A-MEM paper](https://arxiv.org/html/2502.12110)
- 読み出しは query embedding の cosine top-k。図の説明では、リンクされた記憶も合わせて取得されるとされるが、式としては定式化されていない — [A-MEM paper](https://arxiv.org/html/2502.12110)
- 費用は操作あたり約1,200トークン（Table 1 では2,520、Appendix では1,200〜2,500）で、LoCoMo/MemGPT 方式の約16,900と比べて小さい。1操作 $0.0003 未満。処理時間は GPT-4o-mini で5.4秒、Llama 3.2 1B（単一 GPU）で1.1秒 — [A-MEM paper](https://arxiv.org/html/2502.12110)
- LoCoMo（F1, GPT-4o-mini）の結果。ただし列ラベルと本文の対応に不整合の疑いがある — [A-MEM paper](https://arxiv.org/html/2502.12110)

  | 手法 | Multi-hop | Temporal | Single-hop | Adversarial |
  |---|---|---|---|---|
  | A-MEM | 27.02 | 45.85 | 44.65 | 50.03 |
  | MemGPT | 26.65 | 25.52 | 41.04 | 43.29 |

  ablation では link 生成と evolution を両方外すと Multi-hop 9.65、evolution だけ外すと21.35に下がった。
- Mem0 論文が temperature 0 で再実行した A-Mem の LoCoMo J は48.38で、Mem0 の66.88を大きく下回った（自己報告の比較で結果が食い違う）— [Mem0 paper](https://arxiv.org/html/2504.19413)
- 限界: 構成の質が基盤 LLM に依存する。text のみ対応。error bar は未報告 — [A-MEM paper](https://arxiv.org/html/2502.12110)

#### Mem0 / Mem0g（2025-04）
- 抽出フェーズ: 入力は DB 上の会話要約 S、直前 m=10 件のメッセージ、新しいメッセージ対 (m_{t-1}, m_t)。抽出 LLM が候補事実 Ω を出す。要約 S は別の非同期モジュールが定期的に再生成する（本セッションで原典確認）— [Mem0 paper](https://arxiv.org/html/2504.19413)
- 更新フェーズ: 候補事実ごとに vector DB から類似上位 s=10 件を取り、LLM が function calling で4操作から1つを選ぶ。分類器は使わない — [Mem0 paper](https://arxiv.org/html/2504.19413)

  | 操作 | 選ばれる条件 |
  |---|---|
  | ADD | 同等の記憶がない |
  | UPDATE | 補完情報があり、新事実の情報量が多い場合のみ置換 |
  | DELETE | 新情報が既存記憶と矛盾する |
  | NOOP | 変更不要 |

- Mem0g は有向ラベル付きグラフ（Neo4j）。ノードは entity（type、embedding、作成時刻を持つ）、エッジは関係トリプレット。LLM の entity extractor と relationship generator で作り、類似度閾値 t で既存ノードに照合する（t の値は非開示）。conflict detector が衝突を検出し、update resolver（LLM）が古い関係を削除せず invalid と印付けするので、時間推論に使える。検索は2系統: anchor ノードからの近傍探索と、triplet embedding の照合 — [Mem0 paper](https://arxiv.org/html/2504.19413)
- 実験は全て GPT-4o-mini、temperature 0、text-embedding-small-3 — [Mem0 paper](https://arxiv.org/html/2504.19413)
- 書き手は別の抽出 LLM で、メッセージ対ごと（毎ターン）に書く。読み出しは毎クエリの検索注入で、取得量は Mem0 1,764 トークン、Mem0g 3,616 — [Mem0 paper](https://arxiv.org/html/2504.19413)

#### Zep / Graphiti（2025-01）
- グラフは3つの subgraph からなる（本セッションで原典確認）— [Zep paper](https://arxiv.org/html/2501.13956)
  - episode: 生入力（メッセージ/テキスト/JSON）を非可逆圧縮せず保存し、言及する entity と episodic edge で結ぶ。
  - semantic entity: entity と事実エッジ（hyper-edge 可）。
  - community: 強連結な entity を label propagation でまとめ、map-reduce 風の要約を持つ。新ノードは隣接の多数決で逐次割り当て、定期的に全体を再計算する。
- 構築: 現メッセージと直前 n=4 件から entity を抽出する（話者は常に entity にする）。reflection で hallucination を減らす。entity 解決は 1024次元 embedding の cosine と全文検索で候補を出し、LLM が重複判定する。事実の重複排除は同じ entity 対のエッジ内だけで探す。グラフ書き込みは LLM 生成ではなく定義済み Cypher で行う — [Zep paper](https://arxiv.org/html/2501.13956)
- bi-temporal モデル: 事象時間 T（t_valid / t_invalid）と記録時間 T′（t′_created / t′_expired）を持つ。新エッジと関連既存エッジを LLM が比較し、時間的に重なる矛盾があれば旧エッジの t_invalid に新エッジの t_valid を入れる（新情報が優先）— [Zep paper](https://arxiv.org/html/2501.13956)
- 検索: cosine（facts / entity 名 / community 名）、BM25（Neo4j Lucene）、n-hop BFS の3つを使う。rerank は RRF、MMR、episode-mention 頻度、中心ノードからのグラフ距離、cross-encoder（最も精度が高く最も高価）。context には有効期間付きの上位事実と entity 要約を整形して入れる — [Zep paper](https://arxiv.org/html/2501.13956)

#### LongMem（2023-06, NeurIPS 2023）
- 凍結した backbone LLM が過去文脈の attention key/value を cached memory bank に書き、学習する残差 SideNet が retriever/reader として memory を検索・融合する。memory は約65k トークンまで扱える（未確認: 今回再取得せず、論文記憶に基づく）— [arXiv 2306.07174](https://arxiv.org/abs/2306.07174)
- 書き手はモデルの forward pass そのもので（入力 chunk ごとに KV を自動で書く）、読み出しは毎トークンの kNN attention 検索。明示的な更新・矛盾処理はなく、古いものから捨てる（未確認）— [arXiv 2306.07174](https://arxiv.org/abs/2306.07174)

#### HippoRAG（2024-05, NeurIPS 2024）
- 海馬索引理論に倣う。索引時は LLM の OpenIE で文書から KG トリプルを抽出し（schemaless KG）、retrieval encoder で類似 entity 間に synonymy edge を張る。検索時は query の entity を種ノードにして Personalized PageRank を回し、ノードの重みを passage に集約して順位付けする（未確認: 今回再取得せず、要旨・本文の記憶）— [arXiv 2405.14831](https://arxiv.org/abs/2405.14831)
- multi-hop QA で既存 RAG を最大20%上回り、single-step 検索で IRCoT 並みの性能を10〜30倍安く、6〜13倍速く出すと報告（未確認、要旨の記憶）— [arXiv 2405.14831](https://arxiv.org/abs/2405.14831)
- 会話記憶専用ではなく文書記憶の方式。書き込みは索引時のオフライン一括処理。HippoRAG 2（2025）が後継とされる（未確認）— [arXiv 2405.14831](https://arxiv.org/abs/2405.14831)

#### MemoryLLM / パラメトリック方式
- MemoryLLM（2024-02, ICML 2024）は transformer の各層に約1B パラメータの latent memory pool を持ち、新知識を自己更新で pool に書き込む。約100万回の更新後も劣化しないと主張する（未確認: 今回再取得せず）— [arXiv 2402.04624](https://arxiv.org/abs/2402.04624)
- MemOS は plaintext / activation（KV cache）/ parameter（LoRA 等）の3種の記憶を一つの scheduling 枠組みで扱い、基本単位 MemCube に内容と来歴・版などの metadata を持たせて合成・移行・融合できるとする。MIRIX、Mem0、Zep、Memobase、MemU、Supermemory より全カテゴリで上回ると主張するが自己報告。初版2025-07-04、v4 2025-12-03 — [MemOS arXiv 2507.03724](https://arxiv.org/abs/2507.03724v4)
- 別系統の論文 "MemOS: An Operating System for Memory-Augmented Generation"（arXiv 2505.22101）も同じ MemCube 概念を持つ — [arXiv 2505.22101](https://arxiv.org/html/2505.22101v1)

#### Memory-R1（2025-08-27, v5 2026-01-14）
- Mem0 型の ADD/UPDATE/DELETE/NOOP を判断する Memory Manager と、Answer Agent の2つを PPO/GRPO で微調整する。学習データは QA 152対のみ（本セッションで原典確認）— [arXiv 2508.19828](https://arxiv.org/abs/2508.19828)
- Answer Agent は類似検索で60件の候補記憶を取り、関連するものに絞ってから答える（memory distillation）。distillation を外した ablation では F1 が45.0から41.0に下がる。報酬は exact match で、LLM-judge 報酬は回答を長くさせ F1 を下げたため採らなかった — [Memory-R1 html](https://arxiv.org/html/2508.19828)
- LoCoMo 総合の結果 — [Memory-R1 html](https://arxiv.org/html/2508.19828)

  | モデル | 手法 | F1 | J |
  |---|---|---|---|
  | LLaMA-3.1-8B | Mem0 | 30.41 | 45.68 |
  | LLaMA-3.1-8B | MemoryOS | 35.04 | 48.20 |
  | LLaMA-3.1-8B | Memory-R1-GRPO | 45.02 | 62.74 |
  | Qwen-2.5-7B | Mem0 | 30.61 | 53.30 |
  | Qwen-2.5-7B | Memory-R1-GRPO | 43.14 | 61.51 |

#### MIRIX（2025-07-10）
- 記憶を6種に分ける: Core、Episodic、Semantic、Procedural、Resource、Knowledge Vault。multi-agent の枠組みで更新と検索を調整する。ScreenshotVQA で RAG より正答率+35%・保存量−99.9%、LOCOMO 85.4% と自己報告（本セッションで原典確認・要旨）— [arXiv 2507.07957](https://arxiv.org/abs/2507.07957)
- 記憶種別ごとの Memory Manager と Meta Memory Manager、毎ターンの active retrieval（topic 生成→検索）という構成は、今回の要旨からは確認できなかった（未確認）— [arXiv 2507.07957](https://arxiv.org/abs/2507.07957)

#### Nemori（2025-08; ACL 2026 版あり）
- 3モジュール構成: Topic Segmentation、Episodic Memory Generation、Semantic Memory Generation。原理は2つで、会話を意味的な episode に切って整列する Two-Step Alignment と、予測誤差（prediction gap）から新規情報だけを semantic memory に蒸留する Predict-Calibrate（Free-energy 原理に由来）— [Nemori arXiv 2508.03341v3](https://arxiv.org/html/2508.03341v3)
- ACL 2026 版は「将来の有用性を予測しにくさで測る、学習不要の記憶蒸留」と捉え直し、Episodic Memory Integration と Semantic Knowledge Distillation の2モジュールにした — [ACL 2026 long.1607](https://aclanthology.org/2026.acl-long.1607/)

#### LangMem（LangChain）
- 記憶操作は「会話群＋現在の記憶状態 → LLM が拡張/統合 → 新しい状態」という形を取る。semantic memory には2形態がある: Collections（多数のレコードを実行時に検索し、新旧を invalidate か consolidate で調停し、recall は similarity・importance・strength（recency と使用頻度）で重み付け）と、Profiles（固定 schema の単一文書を in-place 更新する）— [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- episodic memory は成功した対話を observation / reasoning / action / result として保存する。procedural memory は prompt optimizer が軌跡とフィードバックから system prompt を改善する — [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- 形成経路を明示的に2つに分ける。hot path（会話中に tool で保存、即時だが latency が増える）と background（会話後やアイドル時に反省して書く、応答 latency ゼロ）。namespace は `{user_id}` などのテンプレートで、保存先は LangGraph BaseStore — [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)

#### Cognee
- ECL（Extract-Cognify-Load）パイプラインで文書・会話から KG と vector 索引を作る OSS（未確認: 今回一次資料を取得していない）。URL のみ記録: [cognee GitHub](https://github.com/topoteretes/cognee)

#### 製品
- **ChatGPT**（help 記事、画面日付 2026-06-04）
  - saved memories: ユーザーが明示的に頼んだもの、または ChatGPT が有用と判断して保存したもの。チャット履歴とは別に保存され、チャットを消しても残る。legacy は個別項目の一覧で、"Improved Memory" は継続更新される広い要約。
  - reference chat history: 過去チャットから関連情報を使う。応答ごとには検索せず、応答が改善しそうな時だけ探す。オフにすると派生情報は30日以内に削除予定。temporary chat（Unpersonalized）は記憶を作らない。
  - 出典: [OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)
- **Claude**（help 記事、2026-10-31 の org 既定変更に言及）
  - chat search: RAG で、tool call として会話内に表示される。project 外の全チャットと各 project 内のチャットを検索するが、project をまたがない。
  - memory（現行版）: 会話中に topic 単位の個別エントリとして保存し、会話後の要約としては作らない。旧版（一部の Team/Enterprise）は24時間ごとに更新する要約型。
  - project ごとに独立した memory を持つ。sensitive topics は既定で保存せず、政府 ID・犯罪歴・金融口座番号・在留資格は頼まれても保存しない。
  - 出典: [Claude help](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
- **Gemini**: 今回、記憶の仕組みの一次資料を確認できなかった（Gaps 参照）。

### Inferences
- 書き込み粒度は「生ログ保持＋派生物」が主流になった。Zep は episode を非可逆圧縮せず保存し、MemGPT は recall storage に全メッセージを持ち、Generative Agents は全観察を残す。Mem0 は事実だけを保存し生ログを捨てるので、後から抽出漏れを取り戻せない。
- 矛盾処理の設計軸は「上書き」か「無効化して保持」か。会話での時間推論（「前は〜だった」）が要るなら bi-temporal（Zep）か invalid 印（Mem0g）が有利で、Mem0g は Temporal J で Mem0 を上回る（58.13 vs 55.51）。
- 「会話モデル自身が tool で書く」方式（MemGPT、製品の明示保存）は function calling の能力に強く依存する。MemGPT 論文の GPT-3.5 劣化や、Memory-R1 の素の LLM manager の誤操作がその例で、小型ローカルモデルでは別の抽出器や背景処理に寄せる設計の方が安定すると推測される。

### Gaps
- Generative Agents・MemoryBank・LongMem・HippoRAG・MemoryLLM の具体数値は今回本文を再取得できず、記憶に基づく（未確認）。
- Gemini の記憶機構（personal context、過去チャット参照）は一次資料を未取得。
- Cognee・Memobase・MemU・Supermemory の書き込み方針は未調査。
- MIRIX の内部 agent 構成と active retrieval は要旨で確認できなかった。

## Q2. 速い会話内経路と遅い背景経路を分ける設計、および latency / token の報告値

### Takeaway
明示的に二経路へ分ける設計は MemGPT（FIFO 追い出し＋再帰要約は同期）、Mem0（要約 S の非同期再生成）、LangMem（hot path / background）、Letta（sleep-time / dreaming）、Generative Agents（閾値起動の reflection）、Zep（community の逐次割当＋定期全再計算）。Mem0 論文の比較では、全文脈方式に対し p95 総 latency を約9割削減しつつ、精度は全文脈方式（J 72.90）に届かない（Mem0 66.88 / Mem0g 68.44）。Zep は LongMemEval で逆に全文脈を上回り、context を115k→1.6k トークンに減らした。

### Cited Findings
- Mem0 の要約 S は本処理の外の非同期モジュールが定期的に再生成し、事実の抽出と更新はメッセージ対ごとに同期で走る — [Mem0 paper](https://arxiv.org/html/2504.19413)
- Mem0 論文の LoCoMo 比較（GPT-4o-mini、1会話平均約26k トークン、adversarial 除外）— [Mem0 paper](https://arxiv.org/html/2504.19413)

  | 手法 | 総合 J | search p50/p95 (s) | 総 p50/p95 (s) | 取得トークン/クエリ |
  |---|---|---|---|---|
  | Full-context | 72.90 | – | 9.870 / 17.117 | 約26,031 |
  | Mem0 | 66.88 | 0.148 / 0.200 | 0.708 / 1.440 | 1,764 |
  | Mem0g | 68.44 | 0.476 / 0.657 | 1.091 / 2.590 | 3,616 |
  | Zep | 65.99 | 0.513 / 0.778 | 1.292 / 2.926 | 3,911 |
  | A-Mem | 48.38 | 0.668 / 1.485 | 1.410 / 4.374 | 2,520 |
  | LangMem | 58.10 | 17.99 / 59.82 | 18.53 / 60.40 | 127 |
  | OpenAI memory | 52.90 | – | 0.466 / 0.889 | 4,437 |
  | 最良 RAG（chunk 256, k=2） | 60.97 | – | – | – |

- Mem0 の p95 削減率は本文で92%、要旨で91%と記載が食い違う — [Mem0 paper](https://arxiv.org/html/2504.19413)
- 1会話あたりの保存量は Mem0 約7k トークン、Mem0g 約14k、Zep は600k 超 — [Mem0 paper](https://arxiv.org/html/2504.19413)
- Zep（自己報告）の結果。latency は住宅回線から AWS までの通信込みで、ベースラインには通信がない — [Zep paper](https://arxiv.org/html/2501.13956)

  | ベンチ | モデル | Zep | 全文脈 | latency（全文脈→Zep） |
  |---|---|---|---|---|
  | DMR | gpt-4-turbo | 94.8% | – （MemGPT 93.4%） | – |
  | DMR | gpt-4o-mini | 98.2% | – | – |
  | LongMemEval（約115k トークン） | gpt-4o-mini | 63.8% | 55.4% | 31.3s → 3.20s |
  | LongMemEval | gpt-4o | 71.2% | 60.2% | 28.9s → 2.58s |

  context は約115k→約1.6k トークン。
- A-MEM は書き込みあたり約1,200〜2,500トークン・5.4秒（GPT-4o-mini）と報告し、この費用は書き込み経路で毎回払う — [A-MEM paper](https://arxiv.org/html/2502.12110)
- LangMem は hot path（即時だが応答 latency が増える）と background（会話後/アイドル時、応答 latency ゼロ）を明示的に分けている — [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- Letta dreaming は一定 step 数ごとか compaction 時に背景 subagent が記憶を統合し、作業を中断しない — [Letta docs](https://docs.letta.com/guides/agents/architectures/sleeptime)
- Sleep-time compute はオフラインの前計算で test-time compute を約1/5にする — [arXiv 2504.13171](https://arxiv.org/abs/2504.13171)
- ChatGPT は過去チャット参照を毎応答では行わず、応答が改善しそうな時だけ行う（読み出し側で費用を抑える）— [OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)
- Claude の現行 memory は会話中に逐次書き、旧版は24時間ごとのバッチ要約だった（背景バッチから会話内書き込みへ移行）— [Claude help](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
- Zep は community を逐次割当（速い経路）と定期全再計算（遅い経路）で更新し、逐次割当は全再計算からずれていくと認めている — [Zep paper](https://arxiv.org/html/2501.13956)

### Inferences
- 「毎ターン抽出（同期）＋要約/統合（非同期）」が実用上の標準形である。応答 latency を決めるのは search の p95（Mem0 0.2秒）で、書き込み LLM 呼び出しは応答後に回せる。ただし Mem0 論文の総 latency 計測が書き込み費用を含むかは要確認（Gaps）。
- LangMem の search p95 60秒は記憶検索を LLM 経由で行う設計の費用を示す例で、読み出しを LLM に任せる設計（MemGPT 型の tool 検索も含む）は応答経路の latency 予算と衝突しやすい。
- 精度は全文脈の方が上という Mem0 の結果（26k トークン）と、記憶の方が上という Zep の結果（115k トークン）は矛盾しない。会話が context 長を超えて長くなるほど、選択的記憶の相対的な優位が出ると読める。

### Gaps
- Mem0 の latency は検索＋回答生成で、書き込み（抽出＋更新）の latency・トークン費用を別建てで報告しているかは今回確認できなかった。
- MemGPT・Generative Agents の書き込み/検索あたりの latency・トークン費用は一次資料で数値を確認していない。
- 製品（ChatGPT/Claude）の記憶処理の latency・費用は非公開。

## Q3. 報告されている強み・弱み・失敗モード

### Takeaway
失敗モードは5類型に整理できる。①自己編集/判断の誤操作（MemGPT の function calling 依存、Mem0 型 manager の DELETE+ADD による断片化）、②検索失敗（MemGPT のページング打ち切り、embedding が正解を下位に置く、Generative Agents の想起漏れ）、③時間情報の欠落による古い事実（OpenAI memory の timestamp 欠落）、④肥大化と費用（Zep 600k トークン超、A-MEM の書き込みごとの多段 LLM 呼び出し）、⑤書き込み直後に読めない整合性遅延（Zep）。ベンチ比較は各論文の自己報告で、条件をそろえると結果が食い違う。

### Cited Findings
- MemGPT は GPT-3.5 の function calling の弱さで劣化し、検索結果を最後までページングせず、embedding 検索が正解文書を下位に置いて性能の上限になった — [MemGPT paper v2](https://arxiv.org/html/2310.08560v2)
- 素の LLM manager（Mem0 型）は「2匹目の犬を飼った」を矛盾と誤認して DELETE+ADD を出し、記憶を断片化させた。RL で学習した manager は1回の UPDATE を出した — [Memory-R1 html](https://arxiv.org/html/2508.19828)
- OpenAI memory は timestamp を欠くことが多く、LoCoMo の Temporal J が21.71と低い。LangMem も Temporal J 23.43 と低い — [Mem0 paper](https://arxiv.org/html/2504.19413)
- Zep は保存量が600k トークン超と大きく、記憶が挿入直後に検索できないことが多かった（Mem0 側の観察）— [Mem0 paper](https://arxiv.org/html/2504.19413)
- Mem0g はグラフ処理で latency が増え、multi-hop では Mem0 を上回らず、single-hop でわずかに劣った — [Mem0 paper](https://arxiv.org/html/2504.19413)
- Zep 自身が報告する弱点: LongMemEval の single-session-assistant 問題で性能が下がった（gpt-4o-mini −9.06%、gpt-4o −17.7%）。community 逐次更新は全再計算からずれる。DMR は小さく単純すぎて評価として弱い — [Zep paper](https://arxiv.org/html/2501.13956)
- A-MEM は構成の質が基盤 LLM に依存し、モデルによって note やリンクが変わる。ablation では link 生成が multi-hop 性能の主因（外すと27.02→9.65）— [A-MEM paper](https://arxiv.org/html/2502.12110)
- 自己報告の食い違いの例 — [A-MEM paper](https://arxiv.org/html/2502.12110); [Mem0 paper](https://arxiv.org/html/2504.19413); [MIRIX](https://arxiv.org/abs/2507.07957); [MemOS](https://arxiv.org/abs/2507.03724v4); [Memory-R1 html](https://arxiv.org/html/2508.19828)
  - A-MEM は自論文で MemGPT/LoCoMo 方式を上回るが、Mem0 論文の再実行では A-Mem J 48.38 と最下位級。
  - MIRIX は LOCOMO 85.4%、MemOS は全カテゴリ首位と主張する。
  - Memory-R1 は 8B 級モデルでの Mem0 J を45.68と報告し、Mem0 論文の GPT-4o-mini での66.88とは条件が異なる。
- Generative Agents の失敗例（想起漏れ、記憶の脚色、過度に丁寧な口調）は本文の記憶に基づく（未確認）— [arXiv 2304.03442](https://arxiv.org/abs/2304.03442)
- 製品側の失敗緩和策 — [OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq); [Claude help](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
  - ChatGPT: 「memory summary は高水準で詳細を落とすことがある」と明記。"Don't mention this again"、応答下の出典表示と relevance フィードバック、削除の反映に時間がかかる。
  - Claude: topic を閲覧・編集・削除できる。sensitive topics は既定で保存せず、特定カテゴリは絶対に保存しない。会話を削除しても記憶エントリは残る。
- 2025〜2026 の主なサーベイ: Hu ら "Memory in the Age of AI Agents"（2025-12, 2026-01改訂、agent memory を LLM memory・RAG・context engineering と区別）、Du ら "Rethinking Memory in AI"（2025-05、6操作: consolidation, updating, indexing, forgetting, retrieval, compression）、"Memory for Autonomous LLM Agents"（2026-03、MemBench・MemoryAgentBench などを含む）。初期の総説は Zhang ら（2024-04）— [arXiv 2512.13564](https://arxiv.org/abs/2512.13564v2); [arXiv 2505.00675](https://arxiv.org/html/2505.00675v1); [arXiv 2603.07670](https://arxiv.org/html/2603.07670); [arXiv 2404.13501](https://arxiv.org/pdf/2404.13501)

### Inferences
- 重複と断片化（同一事実の多重登録、DELETE+ADD）は、更新判断を類似上位 k 件だけを見るプロンプト判断に任せる設計の構造的な弱点で、対策は3方向ある: entity 対単位の重複探索（Zep）、RL での判断学習（Memory-R1）、無効化して保持（Zep/Mem0g）。
- 古い事実の問題は、timestamp を記憶本体に持たない設計（OpenAI 旧 memory、LangMem collections）で temporal 性能の大きな低下として現れる。有効期間を保持する方式が、矛盾処理と時間推論を同時に解く。
- hallucinated memory（実際にはない記憶）を直接測ったベンチ結果は今回見つからなかった。Generative Agents の脚色や Zep の抽出時 reflection は定性的な報告にとどまる。

### Gaps
- 記憶の hallucination 率・重複率・肥大化速度を系統的に測った一次資料は今回見つからなかった。
- Letta の self-editing 誤り（core memory の誤上書き）の定量報告は見つからなかった。
- MemOS・MIRIX の自己報告の第三者による再現は未確認。
