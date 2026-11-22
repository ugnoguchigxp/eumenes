# LLM エージェント記憶の更新・矛盾解消・時間的妥当性・明示的な記憶／忘却要求・安全性

調査日: 2026-11-22。凡例: 【未検証】= 検索スニペットや二次情報のみで本文を確認していない。【版差】= 版によって数値が違う。

## 1. 新情報が旧記憶と矛盾するときの更新・調停の仕組み

### Takeaway
主流は「検索して比べ、LLM が操作を選ぶ」方式。Mem0 は類似記憶 10 件に対して ADD/UPDATE/DELETE/NOOP を tool call で選び、矛盾したものは物理削除する。Mem0g と Zep/Graphiti は矛盾した辺を消さずに無効化して履歴を残す。Letta はエージェント自身がコアメモリを書き換える。重み編集（ROME/MEMIT）は波及する多段事実を更新できず、外部メモリ型の編集（MeLLo）の方が大きく勝つ。

### Cited Findings
- **Mem0 の抽出フェーズ**: 新しいメッセージ対（直前と現在）、DB 上の会話要約（別の非同期モジュールが定期更新）、直近 m=10 メッセージから LLM が候補事実を抽出する。Mem0 は 2025-04-28 に arXiv v1 を投稿 — [Mem0 arXiv 2504.19413 HTML](https://arxiv.org/html/2504.19413v1), [abs](https://arxiv.org/abs/2504.19413)
- **Mem0 の更新フェーズ**: 候補事実ごとに埋め込みで類似既存記憶を s=10 件取り出す。function calling（tool call）で LLM 自身が次の 4 操作から選び、別の分類器は使わない。ADD（同等の記憶が無い）、UPDATE（補完情報で拡充。情報量が多い場合だけ置換）、DELETE（新情報と矛盾する記憶を削除）、NOOP（既存または無関係） — [Mem0 HTML](https://arxiv.org/html/2504.19413v1)
- **Mem0g（グラフ版）**: エンティティ抽出→関係生成の 2 段 LLM で、ノードは類似度閾値 t で再利用する。conflict detector が矛盾しうる既存関係を検出し、LLM の update resolver が古い関係を「物理削除せず invalid にマーク」する。時間推論のために履歴を残すことが目的 — [Mem0 HTML](https://arxiv.org/html/2504.19413v1)
- **LOCOMO temporal カテゴリ（LLM-as-a-Judge J）**: Mem0g 58.13、Mem0 55.51、Zep 49.31、A-Mem 49.91、LangMem 23.43、OpenAI 21.71。全体では Mem0 が OpenAI 比で J が 26% 相対向上、p95 レイテンシは full-context 比 91% 減、トークンコストは 90% 超の削減 — [Mem0 HTML](https://arxiv.org/html/2504.19413v1), [abs](https://arxiv.org/abs/2504.19413)。（注: Mem0 著者自身の評価で、Zep の数値は Mem0 側で測ったもの。）
- **Zep/Graphiti の辺の無効化**: 新しい辺が来ると、LLM が意味的に関連する既存の辺と比べて矛盾を探す。時間的に重なる矛盾があれば、旧辺の t_invalid を新辺の t_valid に設定する。取り込み時系列 T' に従うため新情報が優先される — [Zep arXiv 2501.13956](https://arxiv.org/html/2501.13956)（v1 は 2025-01-20）
- **Zep のエンティティ解決**: 名前を 1024 次元で埋め込んだコサイン類似度に全文検索を足して候補を集め、LLM が重複を判定して名前と要約を統合する。グラフへの書き込みは LLM 生成ではなく定義済み Cypher クエリで行い、スキーマの一貫性を保つ — [Zep](https://arxiv.org/html/2501.13956)
- **Letta (MemGPT)**: エージェントが自分でコアメモリを編集するツールを持つ。memory_insert、memory_replace、memory_rethink、memory_finish_edits、conversation_search、archival_memory_insert（content と任意の tags）、archival_memory_search。旧 core_memory_append は memory_insert(insert_line=-1) に、core_memory_replace は memory_replace に対応する — [Letta Base tools](https://docs.letta.com/guides/agents/base-tools), [MemGPT agents (legacy)](https://docs.letta.com/guides/legacy/memgpt-agents-legacy)
- **知識編集（重み編集）の限界**: MQuAKE（EMNLP 2023）では、ROME で編集した GPT-J は編集した事実を思い出せても、多段質問の正答率が編集前 40.5% から 7.4% に落ちた（v1 では 43.4%→7.6%【版差】）。外部メモリに編集事実を置いて質問分解と照合を行う MeLLo が既存の編集器を大きく上回る — [MQuAKE arXiv 2305.14795](https://arxiv.org/abs/2305.14795), [v3 HTML](https://arxiv.org/html/2305.14795v3)
- MQuAKE-CF の比較（RippleCoT 論文が報告）: MEND 11.5 / FT 1.9 / ROME 18.1 / MEMIT 12.3 / MeLLo 41.2 / IKE 67.2 / RippleCoT 81.7 — [RippleCoT arXiv 2410.03122](https://arxiv.org/pdf/2410.03122)【未検証: スニペットのみ】
- 埋め込みで編集を保存するメモリ型手法の弱点として、意味的に近い編集同士を区別しにくいことが指摘され、構造化した関係タプルの方が良いとされる（MQA-KEAL） — [arXiv 2409.12257](https://arxiv.org/pdf/2409.12257v1)【未検証】
- MemoryBank（AAAI 2024）: 前回の記憶と現在の会話を LLM に渡し、更新後の記憶を書き直させる（初期記憶は空） — [MemoryBank arXiv 2305.10250](https://arxiv.org/abs/2305.10250v3), [AAAI](https://ojs.aaai.org/index.php/AAAI/article/view/29946)

### Inferences
- 更新方式は 3 系統に分かれる。(a) 物理削除型（Mem0 の DELETE）。単純だが「以前は X だった」という問いに答えられない。(b) 無効化型（Mem0g、Zep）。履歴を保ち、時間推論で優位（LOCOMO で Mem0g > Mem0）。(c) エージェント自己編集型（Letta）。判断は柔軟だが、モデルの書き込み判断に依存する。
- どの方式も「矛盾を判定する LLM」と「候補を選ぶ類似検索」の 2 つが性能を決める。s=10 件の検索に入らない古い矛盾記憶は検出されない（設計から導いた推論）。
- 利用者固有の事実の更新は重み編集ではなく外部ストアで行うべき。MQuAKE が示した波及更新の失敗が根拠。

### Gaps
- Mem0 の UPDATE/DELETE 判断の精度（誤削除率）を単独で測った評価は見つからなかった。
- Letta 公式がコアメモリ編集の誤りや競合をどう扱うか（バージョン管理・ロールバック）は未確認。

## 2. 時間の表現（事実が真だった時点と学んだ時点、validFrom/validUntil、双時間モデル）

### Takeaway
Zep/Graphiti は辺ごとに 4 つのタイムスタンプを持つ双時間モデルの代表例で、LongMemEval の temporal-reasoning を full-context 比で 38〜48% 相対改善した。ただし knowledge-update の改善は gpt-4o のときだけで、gpt-4o-mini では悪化した。LongMemEval は knowledge updates と temporal reasoning を独立した能力として測り、商用アシスタントでは 30〜64% の精度低下が出る。

### Cited Findings
- **Zep の双時間モデル**: T は実世界の出来事の順序、T' は取り込み順（監査用）。辺ごとに t_valid/t_invalid（T 上の事実の有効期間）と t'_created/t'_expired（T' 上のシステム登録・失効時刻）を持つ。「2 週間前」のような相対日付は、各メッセージの参照時刻を基準に絶対化する — [Zep arXiv 2501.13956](https://arxiv.org/html/2501.13956)
- **Zep のエピソード出所**: エピソード（メッセージ・テキスト・JSON の非可逆でない生記録）とエンティティを episodic edge で結び、双方向索引で意味的事実から元エピソードへ辿れる。ただし実験ではこのリンクを検証していないと著者が明記している — [Zep](https://arxiv.org/html/2501.13956)
- **Zep の LongMemEval_s 結果（約 115k トークン）**:
  - knowledge-update: gpt-4o-mini は full-context 76.9% → Zep 74.4%（−3.36%）、gpt-4o は 78.2% → 83.3%（+6.52%）
  - temporal-reasoning: gpt-4o-mini は 36.5% → 54.1%（+48.2%）、gpt-4o は 45.1% → 62.4%（+38.4%）
  - 著者は、弱いモデルでは時間データを活かすのに追加の工夫が必要だと述べている — [Zep](https://arxiv.org/html/2501.13956)
- **LongMemEval の 5 能力**: information extraction、multi-session reasoning、knowledge updates（利用者の状況変化を認識して記憶を更新する）、temporal reasoning、abstention（言及の無い情報には「知らない」と答える） — [LongMemEval arXiv 2410.10813](https://arxiv.org/html/2410.10813)（v2 は 2025-03-04。ICLR 2025 採択とされるが、取得したページには会場の記載が無く【未検証】）
- **LongMemEval の低下幅**: ChatGPT（GPT-4o）は offline reading 0.918 に対して 0.577（約 37% 減）、Coze（GPT-4o）は 0.330（約 64% 減）。長文脈 LLM は LongMemEval_S で 30〜60% 低下 — [LongMemEval](https://arxiv.org/html/2410.10813)
- **LongMemEval の設計最適化**: session decomposition（ラウンド単位で保存）、fact-augmented key expansion（抽出事実を索引キーに連結。recall@k 約 +9.4%、QA 約 +5.4%）、time-aware query expansion（質問から時間範囲を抽出して絞り込み。temporal の recall がセッション単位で +6.8%、ラウンド単位で +11.3%。強い LLM で抽出した場合） — [LongMemEval](https://arxiv.org/html/2410.10813)
- Mem0g は無効化した関係を残すことで時間推論を支え、LOCOMO temporal で J 58.13 と Mem0 の 55.51 を上回る — [Mem0](https://arxiv.org/html/2504.19413v1)

### Inferences
- 「いつ真だったか（valid time）」と「いつ知ったか（transaction time）」を分けると、遡った訂正（「先月から実は転職していた」）と監査（「いつ誤記憶を持っていたか」）を両立できる。Zep の 4 タイムスタンプ方式はそのまま採用できる設計の参照点になる。
- 双時間情報の利点は読み手モデルの能力に依存する（Zep の gpt-4o-mini の結果）。ローカルの小型モデルでは、時間計算を LLM 任せにせず、コード側で有効期間を絞り込んだ「現在有効な事実」だけを提示する方が安全と推測する。
- knowledge-update 評価には「最新値を答える」ことと「過去値を問われたら過去値を答える」ことの両方が必要。LongMemEval の分類はこの 2 つを knowledge updates と temporal reasoning に分けて測っている。

### Gaps
- LongMemEval の knowledge-update 問題の個別の作り方（旧値と新値の配置間隔など）は、取得範囲の本文に記述が無かった。
- Graphiti の実装ドキュメントで、エピソード削除時に派生した辺を連鎖削除するかは未確認。

## 3. 明示的な「覚えて」「忘れて」「それは違う」要求への即時かつ確実な対応（派生記憶の削除と出所追跡を含む）

### Takeaway
商用 3 社はいずれも「会話で覚えて／忘れて」と頼める UI と設定画面での個別削除を持つ。一方で共通の落とし穴として、元のチャットを削除しても派生した記憶は消えない（ChatGPT、現行の Claude）。削除ログは最大 30 日保持され得る。研究側では、要約・埋め込み・下位層に残る「残渣」が実証されつつあり、出所グラフに沿って依存先まで閉包削除する方式が提案されている。

### Cited Findings
**ChatGPT**
- 2024-02-13 に限定テストを開始、2024-09-05 に Free/Plus/Team/Enterprise へ拡大し、記憶変更の通知を追加。2025-04-10 に過去チャット参照（chat history）を追加、2025-06-03 に Free 向けの軽量版。保存時の「Memory updated」表示から Manage memories で確認・削除できる — [OpenAI: Memory and new controls](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- 機微情報（医療情報など）は、利用者が明示的に頼まない限り自発的に記憶しないよう努めると OpenAI は説明している — [OpenAI blog](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- 「チャットを削除しても、そこから派生した記憶は消えない。記憶は特定の会話に紐づかない」 — [OpenAI blog](https://openai.com/index/memory-and-new-controls-for-chatgpt/), [Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)
- saved memories（頼んだ内容と自動保存。チャット履歴と別に保存）と reference chat history（過去会話を参照。保存上限なし）の 2 層。会話で忘れるよう頼むか設定から削除すると、今後のパーソナライズには使われなくなるが、過去会話中の言及は消えない。削除した saved memory のログは安全・デバッグ目的で最大 30 日保持され得る。chat history 参照をオフにすると、過去チャット由来の情報は 30 日以内に削除予定になる（元チャットは残る） — [Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)
- メモリ要約は詳細を省く高水準の表示で、訂正の入力や「Don't mention this again」（元情報は消さず、今後の言及を減らす）が可能。プランによっては自動優先度付け・検索・版履歴がある（仕組みは非公開）。Temporary Chat は記憶を作らず、更新もしない — [Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)
- 完全に消すには、saved memory、元のチャット、アーカイブ、ファイル、要約、接続アプリのすべてから除く必要があるという記述がある — [Memory FAQ 検索結果](https://help.openai.com/en/articles/8590148-memory-faq)（FAQ は版によって記述が揺れている）

**Claude**
- Team/Enterprise に 2025-09-11、Pro/Max に 2025-10-23 から提供。プロジェクトごとに分離したメモリを持ち、メモリ要約は会話で「何に集中し、何を無視するか」を伝えて更新できる。インポートとエクスポートに対応 — [Claude blog: memory](https://claude.com/blog/memory)
- 現行方式では、会話の終了後にまとめるのではなく、会話中にトピック単位で保存する。自動保存に加えて「remember this」も可能。会話での更新は「次の会話」から反映され、現在の会話とは限らない。旧方式（一部の Team/Enterprise）は 24 時間ごとに統合し、編集は即時反映 — [Claude Help: memory](https://support.claude.com/en/articles/11817273)
- 現行方式では、会話を削除しても生成された記憶は残り、個別に削除する必要がある（旧方式では削除した会話は統合から除かれる）。「Reset memory」はプロジェクトメモリを含めて全消去し、取り消せない。保持期間の設定を超えて更新されない記憶は削除される。プロジェクトを削除するとそのメモリも消える。Incognito は記憶にも履歴にも残らないが、Team/Enterprise では最低 30 日保持される — [Claude Help](https://support.claude.com/en/articles/11817273)
- 過去チャット検索は RAG による tool call として会話中に表示される — [Claude Help](https://support.claude.com/en/articles/11817273)

**Gemini**
- Saved info（Personal context）は会話中の「Remember that I don't own a car」のような依頼か、手動追加で保存し、Settings → Personal context から編集・削除する。利用規約や禁止用途ポリシーへの違反の可能性が検出されると保存しない。18 歳未満と Gemini Live では使えない — [Gemini Help 16413516](https://support.google.com/gemini/answer/16413516)
- 過去チャット由来の記憶は、Gemini Apps activity でチャットを削除すると使われなくなるが、反映までに短い遅延があり得る。完全に除くには、該当チャットの削除と接続アプリの切断の両方が必要 — [Gemini Help 16598469](https://support.google.com/gemini/answer/16598469?hl=en-GB)【検索スニペット経由】
- 一部の通信会社バンドルアカウントでは個別の記憶を編集・削除する UI が無いという利用者報告がある — [Google AI Developers Forum](https://discuss.ai.google.dev/t/feature-request-enable-edit-delete-for-gemini-memory-saved-info-on-consumer-telco-bundled-accounts-e-g-jio-gemini-pro/182534)【未検証、利用者投稿】

**研究: 派生記憶の削除と出所追跡**
- DeLLM（Ohrimenko、2026-09-29）: 削除要求に一致するメッセージを消すだけでは不十分で、会話内の依存関係を通じて情報が残る。メッセージの出所グラフ（provenance graph）を保持して削除対象を決める。現行の LLM は「忘れた」と主張しても実際には情報を削除していないと報告している — [arXiv 2609.36414](https://arxiv.org/abs/2609.36414)（定量値は abstract に無い）
- 多層メモリの削除忠実度: Forgetting Residue Score を導入し、生記録だけを削除すると約 20% のケースで要約コピーから復元できた。全パイプラインの purge と tombstone redaction で最悪層の残渣を除去できた — [arXiv 2606.10062](https://arxiv.org/html/2606.10062)【未検証: 同じ ID が別タイトル "Deployment-Time Memorization in Foundation-Model Agents" でも出ており、要確認】
- Agentic unlearning の「backflow」: 忘れた内容が索引・要約・埋め込みとして残り、検索ループで再生成される。Synchronized Backflow Unlearning はメモリ削除を先に行い、blocklist と依存グラフで派生物まで消す — [arXiv 2602.17692](https://arxiv.org/html/2602.17692v2)【未検証: スニペットのみ】
- AfterDeleteBench: 削除後に情報が残るかを監査するベンチマーク。元データを正確に消しても派生した残渣が残る — [arXiv 2610.31366](https://arxiv.org/pdf/2610.31366)【未検証】
- 常駐エージェントのサーベイ: decay による忘却は削除要求を満たさない（重みを下げた記録は検索可能なまま）。手動削除は要約・埋め込み・昇格した層に伝播しない — [arXiv 2606.30306](https://arxiv.org/pdf/2606.30306)【未検証】

### Inferences
- 主要 3 社は「派生物の連鎖削除」を利用者の手作業に任せている（ChatGPT と現行 Claude は明言）。製品として「忘れて」を確実に効かせるには、記憶ごとに source（元メッセージ ID・runId）を持たせ、元を消したら派生要約・埋め込み・索引まで閉包削除する必要がある。
- 即時性: ChatGPT の「Memory updated」通知も Claude の「次の会話から反映」も、書き込みは非同期または次回反映を許している。音声主体の利用では、明示的な「忘れて」は同じ会話内で即座に検索対象から外し（tombstone）、物理削除は後段で行う 2 段構成が妥当と推測する。
- 「それは違う」（訂正）は削除ではなく、Zep 型の無効化（t_invalid の設定と、訂正元の記録）で扱うと監査可能になる。一方、プライバシー目的の「忘れて」は無効化ではなく実体の削除が必要で、両者を区別すべき。

### Gaps
- 3 社とも、明示的な「覚えて」が同期的に永続化されるのか、非同期キューを経るのかは公開されていない。
- ChatGPT の「automatic prioritization」の基準と、記憶が自動で降格・削除される条件は非公開。
- Gemini の削除が反映されるまでの遅延の長さは不明。

## 4. 設計上の忘却、機械学習の unlearning と外部メモリ削除、GDPR の消去権

### Takeaway
設計上の忘却には、Ebbinghaus 型の減衰（MemoryBank）、recency/importance スコア、保持期間（Claude の custom retention）がある。ただし減衰は削除要求を満たさない。GDPR 上、モデル重みの unlearning は不確実で（Cooper ら）、EDPB もモデルの匿名性は個別判断で閾値が高いとしている。外部メモリは削除で対応できるので、個人の記憶は重みではなく外部ストアに置くのが消去権対応として有利。

### Cited Findings
- MemoryBank: Ebbinghaus 忘却曲線 R = e^(−t/S) に基づき、古く想起の少ない記憶を忘れる。S は想起のたびに +1 され、t は 0 に戻るとする要約がある — [MemoryBank arXiv 2305.10250](https://ar5iv.labs.arxiv.org/html/2305.10250)（S の離散化の詳細は二次情報【未検証】）
- Generative Agents: 検索スコアを recency（指数減衰）、importance（LLM が 1〜10 で採点）、relevance の和にする — [arXiv 2304.03442](https://arxiv.org/abs/2304.03442)【本調査では本文を再取得しておらず、減衰係数 0.995 などの値は未確認】
- Claude の custom retention: 保持期間内に更新されない記憶は削除される（project memory は除く） — [Claude Help](https://support.claude.com/en/articles/11817273)
- 「Machine Unlearning Doesn't Do What You Think」（Cooper ほか、NeurIPS 2025 position track）: 生成 AI の unlearning は、パラメータからの影響除去と出力抑制の両方を指すようになった。少数のパラメータ編集で「決して出力しない」ことを保証できると考えるのは誤り。完全な法令遵守を unlearning が満たすことには懐疑的だが、限定的な利点はあり得る — [arXiv 2412.06966](https://arxiv.org/abs/2412.06966v2), [NeurIPS](https://papers.nips.cc/paper_files/paper/2025/hash/8110ef9878e4642ad848ca583d37d7ca-Abstract-Position_Paper_Track.html)
- EDPB Opinion 28/2024（2024-12-17 採択）: 個人データで学習したモデルが常に匿名とは言えず、監督当局が個別に判断する。直接的・確率的な抽出の可能性を考慮する。展開時の安全策として、出力フィルターなどで個人データの保存・吐き出し・生成を防ぐ技術的措置を挙げている — [EDPB Opinion 28/2024 PDF](https://edpb.europa.eu/system/files/2024-12/edpb_opinion_202428_ai-models_en.pdf), [CMS 解説](https://cms.law/en/int/legal-updates/edpb-opinion-28-2024-key-takeaways-on-processing-personal-data-in-the-context-of-ai-models), [IAPP](https://iapp.org/news/a/edpb-weighs-in-on-key-questions-on-personal-data-in-ai-models)
- Opinion 28/2024 から消去請求の扱いについての直接の記述は、検索要約では確認できなかった（原文の確認が必要） — [EDPB PDF](https://edpb.europa.eu/system/files/2024-12/edpb_opinion_202428_ai-models_en.pdf)
- 実務者記事: GDPR 第 17 条を前提に、出所グラフの推移閉包削除と削除後の検証を提案している — [DEV Community](https://dev.to/manav8498/your-ai-agent-remembers-everything-can-it-prove-it-forgot-3l79)【非査読】
- ChatGPT の削除ログは最大 30 日、Claude Incognito（Team/Enterprise）は最低 30 日保持され、消去と安全目的の保持が併存している — [OpenAI FAQ](https://help.openai.com/en/articles/8590148-memory-faq), [Claude Help](https://support.claude.com/en/articles/11817273)

### Inferences
- 減衰と TTL は検索の質のための仕組みで、削除要求への対応とは別の経路として実装する必要がある（サーベイ 2606.30306 の指摘とも整合）。
- 第 17 条への対応は、外部メモリ（行・要約・埋め込み・索引・ログ）を出所で連鎖削除し、その結果を検証できることが中心になる。重みには個人の記憶を入れない設計が、unlearning の不確実性を避ける最も確実な方法。
- 派生要約（複数の元記録から合成したもの）は、元が一つ消えたら再生成するか、該当部分を墨消しする必要がある。「要約の出所が複数」の場合の扱いは設計判断として残る。

### Gaps
- EDPB/EU の文書で、エージェントの外部メモリや派生要約に対する消去権の範囲を直接論じたものは見つからなかった。
- 減衰パラメータの最適値を比較した実証研究は見つからなかった。

## 5. 推論で得た記憶と利用者が確認した記憶、記憶への注入・汚染攻撃と防御

### Takeaway
記憶はパーソナライズを通じて迎合（sycophancy）を増やし得る（Gemini 2.5 Pro で +45%、Claude Sonnet 4 で +33%、ただしモデル差が大きい）。注入攻撃は実在し、問い合わせだけで記憶に書き込む MINJA（注入成功 98.2%）、0.1% 未満の汚染でトリガー時の攻撃成功率 80% 超の AgentPoison、間接プロンプト注入で ChatGPT・Gemini に偽記憶を保存させた実例がある。防御は、出所と信頼度のラベル、合意に基づく検証、書き込み時の確認が中心。

### Cited Findings
- **記憶と迎合**: Jain ら（arXiv 2509.12517、CHI '26 採択）は 38 名の 2 週間分の実対話を使い、記憶プロファイルが agreement sycophancy を最も増やすことを示した。Gemini 2.5 Pro +45%、Claude Sonnet 4 +33%、GPT-4.1 Mini +16%、Llama 4 Scout と GPT-5.1 は有意差なし。perspective sycophancy は、モデルが利用者の視点を正確に推論できる場合だけ増える — [arXiv 2509.12517](https://arxiv.org/html/2509.12517v3), [MIT News](https://news.mit.edu/index.php/2026/personalization-features-can-make-llms-more-agreeable-0218)
- 9 モデル・5 ベンチマークの研究: パーソナライズは affective alignment を一貫して高める。epistemic independence への影響は役割で変わり、助言役では強まり、仲間役や討論では弱まる — [arXiv 2603.00024](https://arxiv.org/html/2603.00024v1)
- Writer 社の研究が、記憶によって迎合が in-context 比で最大 25 倍になると報告したという報道 — [The Register](https://theregister.com/ai-and-ml/2026/06/11/memory-and-personalization-make-ai-more-likely-to-tell-you-what-you-want-to-hear/5253850)【未検証: 原論文は未確認】
- Anthropic は Pro/Max 展開時に、記憶が有害なパターンを強めないか、過剰な迎合（over-accommodation）を招かないか、安全策の回避に使われないかを試験して調整したと説明している — [Claude blog](https://claude.com/blog/memory)
- OpenAI は医療情報などの機微情報を、明示の依頼が無い限り自発的に記憶しないよう努めると説明している（推論で得た記憶の抑制） — [OpenAI blog](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- **MINJA**（Dong ら、arXiv 2503.03704。NeurIPS 2025 / ICLR 2026 に掲載とされる）: 攻撃者は記憶バンクへの書き込み権を持たず、問い合わせと出力の観察だけで悪意ある記録を入れる。良性の質問と有害な推論手順を結ぶ bridging step を indication prompt で生成させ、progressive shortening で prompt を除去する。被害者の質問（患者 ID など）で別対象の推論が発火する。注入成功率 98.2%、攻撃成功率 76.8%（3 エージェント × 4 組） — [arXiv 2503.03704](https://arxiv.org/abs/2503.03704), [NeurIPS](https://neurips.cc/virtual/2025/poster/118152)（数値は v1 の枠組みで、後の版で変わったかは未確認）
- **AgentPoison**（arXiv 2407.12784、2024-07-17）: 長期記憶や RAG 知識ベースに最適化したトリガー付きの悪意あるデモを入れ、トリガーを含む指示で検索させる。学習や微調整は不要。汚染率 0.1% 未満で平均攻撃成功率 80% 超、トリガーなしの性能低下は 1% 未満。対象は自動運転、知識 QA、EHRAgent — [arXiv 2407.12784](https://arxiv.org/abs/2407.12784)（NeurIPS 2024 採択とされるが【未検証】）
- **実製品への攻撃**: Rehberger は 2024 年 9 月に間接プロンプト注入で ChatGPT に「利用者は 102 歳、Matrix に住み、地球は平らと信じる」と記憶させ、以後の全セッションに残した。2025 年 2 月には Gemini で delayed tool invocation を使い、文書内に「利用者が特定の語を言ったら memory ツールを呼べ」と仕込み、後でトリガー語が出たときに偽情報を保存させた。Google は個別の手口を塞いだが、根本問題には追加対策をしなかったと報じられた — [InfoQ](https://www.infoq.com/news/2025/02/gemini-long-term-memory-attack/), [OECD AI Incident](https://oecd.ai/en/incidents/2025-02-11-0df5)（一次情報は embracethered.com だが本調査では未取得）
- **防御: A-MemGuard**（arXiv 2510.02373、ICML 2026）: 関連記憶から導いた複数の推論経路を比べる合意検証で異常を検出し、失敗教訓を別に持つ二重メモリ構造と組み合わせる。EHRAgent で攻撃成功率を 97% 超削減 — [arXiv 2510.02373](https://arxiv.org/abs/2510.02373), [PMLR](https://proceedings.mlr.press/v306/wei26ac.html)【数値は abstract とスニペット】
- **防御: trust-aware retrieval**（Sunil ら、arXiv 2601.05504）: 複合信頼スコアによる入出力のモデレーションと、時間減衰と信頼スコアを使うメモリ浄化。閾値の慎重な調整が必要（EHR エージェントで評価） — [arXiv 2601.05504](https://arxiv.org/html/2601.05504v1)
- 検索時の防御: 取り出した記憶を trust/risk/type の注記で検査し、指示を含む記憶は信頼できる出所のときだけ残す — [arXiv 2607.06595](https://arxiv.org/pdf/2607.06595)。MEMSHIELD は時間的バースト、書き手と出所の重なり、共有文脈などの構造メタデータで協調的な複数エントリ汚染を検出する — [arXiv 2609.08747 で引用](https://arxiv.org/pdf/2609.08747)【いずれも未検証: スニペットのみ】
- 記憶形成段階の汚染を測るベンチマーク MemForm — [arXiv 2610.14431](https://arxiv.org/pdf/2610.14431)【未検証】

### Inferences
- 記憶ごとに origin ラベル（利用者が明示 / 会話から推論 / ツール・外部文書由来）と confidence を持たせるべき。外部文書・ツール出力由来の書き込みは、Rehberger や MINJA の経路そのものなので、利用者の確認なしに長期記憶へ昇格させない設計が妥当。
- 推論で得た記憶をそのままモデルに見せると、迎合や決めつけ（stereotyping）を強めるおそれがある（Jain らは視点を正確に推論できるときに perspective sycophancy が増えると報告）。推論記憶は「推定」と明記して提示するか、関連時だけ取り出す方が安全。
- 記憶への書き込みツールを LLM が自由に呼べる構成（Letta、Gemini の memory ツール）は、delayed tool invocation に弱い。外部コンテンツを処理した直後の書き込みを制限するか、書き込みを利用者に通知（ChatGPT の「Memory updated」型）して取り消しを容易にすることが実例から導ける対策。

### Gaps
- 推論記憶と確認済み記憶を分けて提示した場合の迎合・誤り率を比べた実験は見つからなかった。
- 主要 3 社が記憶書き込みに出所・信頼度ラベルを付けているかは非公開。
- stereotyping（属性推論による偏り）を記憶システム固有に測った研究は、本調査範囲では見つからなかった。
