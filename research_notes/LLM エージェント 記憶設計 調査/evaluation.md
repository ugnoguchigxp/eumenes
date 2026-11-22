# 長期会話記憶の評価: ベンチマーク・指標・報告結果・評価方法論

調査日: 2026-11-22。「[未検証]」は、今回の調査でページを取得して確かめていない記述（調査者の事前知識、または検索スニペットのみ）。数値は出典の表記どおりで、ベンダー自身の測定値はその旨を書いた。

---

## Q1. ベンチマーク: 何を測るか・規模・指標・既知の弱点

### Takeaway
最も多く引用されるのは LoCoMo と LongMemEval だが、どちらも最新の長文脈モデルの窓に収まる長さ（LoCoMo は約16k〜26k tokens、LongMemEval_S は約115k tokens）で、「記憶の設計」よりも「文脈管理」を測ってしまう面がある。LoCoMo には答えキーの誤り（約6.4%）、甘い judge、adversarial（回答不能）カテゴリの除外という問題がある。2025〜2026 年の後発ベンチマークは、より長い会話（BEAM: 最大1,000万 tokens）、忘却と更新（Memora、BEMULA、MemoryAgentBench）、動的・on-policy 評価に移っている。日本語の長期記憶 QA ベンチマークで確立したものは見つからなかった。

### Cited Findings

**LoCoMo (Maharana et al., arXiv 2402.17753, 2024)**
- 人格と時系列の出来事グラフから生成した長期対話。1会話あたり平均約19セッション、9,000 tokens 超 — [Mnemoverse LoCoMo page](https://mnemoverse.com/docs/technology/benchmarks/locomo)（二次資料）。原論文の規模（10会話・平均約300ターン・最大35セッション、QA 約1,986問・5カテゴリ。QA のほかに出来事要約と多モーダル対話生成の課題も含む）[未検証、事前知識] — [arXiv 2402.17753](https://arxiv.org/abs/2402.17753)
- QA カテゴリは single-hop / multi-hop / open-domain / temporal / adversarial（cat.5）。Mem0 論文は「正解が用意されていない」として adversarial を除外 — [Mem0 paper, arXiv 2504.19413](https://arxiv.org/html/2504.19413)
- 指標: 原論文は F1。Mem0 以降は F1・BLEU-1 と LLM-as-judge の正答率「J」を併記するのが慣行 — [Mem0 paper](https://arxiv.org/html/2504.19413)
- 批判①（Zep, 2025-05-06）: 会話が約16k〜26k tokens と短く、文脈窓に収まる。BLIP で作った画像説明に載っていない画像の詳細を問う設問、話者の取り違え、正解が複数ありうる曖昧な設問がある。知識更新（knowledge update）の設問がない — [Zep blog "Lies, Damn Lies, & Statistics"](https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
- 批判②（Penfield Labs による監査, `dial481/locomo-audit`）: 1,540問中99問（6.4%）の答えキーが誤りで、到達可能な上限は約93.6%。標準の GPT-4o-mini judge は、話題は合っているが意図的に誤らせた回答の62.81%を正解と判定した — [Bloo-mind essay (2026-05-20)](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/), [Reddit r/MachineLearning audit post](https://www.reddit.com/r/MachineLearning/comments/1s54cvg/d_we_audited_locomo_64_of_the_answer_key_is_wrong/)
- 批判③: Mem0 の公開ハーネスは `CATEGORIES_TO_EVALUATE = [1,2,3,4]` で、cat.5 の446問（全体の22.5%）を落とす。回答プロンプトは "NEVER say 'not specified'"、"COMMIT AND ANSWER" と指示しており、棄権（「わからない」と答えること）が測れない。judge は日付 ±14日、期間 ±50% を許容する — [DEV: "The AI-memory benchmark everyone quotes forbids saying 'I don't know'" (G. D'Erme)](https://dev.to/gde03/the-ai-memory-benchmark-everyone-quotes-forbids-saying-i-dont-know-o1n)
- 改訂版 LoCoMo-Refined: 問題のある337サンプルを除き、改良 judge（Qwen3-14B）の人手との一致率は86.33%（元の設定は43.67%） — [Bloo-mind essay](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/), [GitHub mem-eval-suite/LoCoMo_refined](https://github.com/mem-eval-suite/LoCoMo_refined)

**LongMemEval (Wu et al., arXiv 2410.10813, ICLR 2025)**
- 人手で精選した500問。測る能力は5つ: information extraction、multi-session reasoning、temporal reasoning、knowledge updates、abstention。設問は7種（single-session user / assistant / preference ほか）。abstention 用に、他の設問を偽の前提に書き換えた設問が30問 — [arXiv 2410.10813 (HTML)](https://arxiv.org/html/2410.10813)
- 設定は2種: LongMemEval_S（1問あたり約115k tokens）と LongMemEval_M（500セッション、約1.5M tokens） — [同上](https://arxiv.org/html/2410.10813)
- 指標: GPT-4o（gpt-4o-2024-08-06）judge の正答率。人手の専門家との一致率は97%超。検索段は Recall@k と NDCG@k で評価 — [同上](https://arxiv.org/html/2410.10813)
- 弱点: knowledge update の操作は最大2セッションに限られる — [Memora, arXiv 2604.20006](https://arxiv.org/html/2604.20006v1)。_S は最新モデルの窓に収まる — [Bloo-mind essay](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)

**MSC / DMR**
- MSC (Xu et al., "Beyond Goldfish Memory", arXiv 2107.07567, 2021): クラウドワーカーが人格文を持って最大5セッション対話するデータセット — [arXiv 2107.07567](https://arxiv.org/pdf/2107.07567)。主な評価は perplexity と人手評価 [未検証]
- DMR (Deep Memory Retrieval, MemGPT 論文 arXiv 2310.08560): MSC の過去セッションについて問う QA。Zep 論文 (arXiv 2501.13956) は DMR で Zep 94.8%、MemGPT 93.4% と報告し、DMR は会話が短く評価として不十分だとして LongMemEval でも評価した [未検証、事前知識] — [arXiv 2501.13956](https://arxiv.org/abs/2501.13956)

**その他の英語ベンチマーク**
- BEAM ("Beyond a Million Tokens", arXiv 2510.27246, ICLR 2026): 100会話（約100K〜10M tokens）と2,000問。長さの区分は 128K / 500K / 1M / 10M。information extraction、instruction following、contradiction resolution など10能力を測る。長い文脈窓を持つ LLM も、会話が長くなるほど大きく性能が落ちる。著者が提案した LIGHT（episodic / working / scratchpad の3記憶）は、強いベースラインより平均3.50〜12.69%改善 — [arXiv 2510.27246](https://arxiv.org/pdf/2510.27246), [GitHub BEAM](https://github.com/mohammadtavakoli78/BEAM)
- MemoryAgentBench (Hu, Wang, McAuley, arXiv 2507.05257, v1 2025-07-07 / v4 2026-06-28): 4能力（accurate retrieval、test-time learning、long-range understanding、selective forgetting）。既存の長文脈データを、情報が少しずつ入ってくる複数ターン形式に変換して使う。結論は「4能力すべてを満たす手法はない」 — [arXiv 2507.05257](https://arxiv.org/abs/2507.05257)。データセット名（EventQA、FactConsolidation）と数値 [未検証]
- Memora (arXiv 2604.20006, 2026-04-21): 数週間〜数か月の会話で remembering / reasoning / recommending の3課題。10人格 ×（週次: 約155セッション・150問 ／ 月次: 約615セッション・150問 ／ 四半期: 約1,991セッション・300問）。指標 FAMA は忘却を考慮した記憶精度（Q3 で詳述） — [arXiv 2604.20006](https://arxiv.org/html/2604.20006v1)
- BEMULA (arXiv 2610.18052, 2026-10-13): 明示的な忘却依頼に従えるかを測る。50対話・忘却依頼135件（6種）・1,742問 — [arXiv 2610.18052](https://arxiv.org/abs/2610.18052)
- MemoryBench (arXiv 2510.17281)、AMemGym (arXiv 2603.01966)、MEMTRACK (arXiv 2510.01353)、CASCADE (arXiv 2605.06702) は動的・on-policy 系 — [Bloo-mind essay](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)
- 多モーダル: MEMLENS（789問、32K〜256K tokens、multi-session reasoning ではほとんどのシステムが30%未満）、Mem-Gallery — [MEMLENS arXiv 2605.14906](https://arxiv.org/pdf/2605.14906v1), [Mem-Gallery arXiv 2601.03515](https://arxiv.org/pdf/2601.03515)。EvolMem（非宣言的記憶が一貫して弱い） — [arXiv 2601.03543](https://arxiv.org/html/2601.03543v1)
- PerLTQA (arXiv 2402.16288)、MemBench、LongBench (arXiv 2308.14508)、∞Bench (arXiv 2402.13718): 今回は一次資料を取得していない。PerLTQA は人格の意味記憶と出来事記憶に基づく QA、LongBench と ∞Bench は会話記憶ではなく汎用の長文脈ベンチマーク [未検証、事前知識]

**日本語**
- Japanese Multi-Session Chat (LREC 2024): MSC と同じ手順で、3セッション版と5セッション版の日本語データを収集。比較用に実際の長期雑談も収集した。コードは GitHub `nttcslab/japanese-long-term-chat` — [ACL Anthology 2024.lrec-main.322](https://aclanthology.org/2024.lrec-main.322.pdf)
- RealPersonaChat（名古屋大学）: 参加者本人の人格を使った日本語対話 約14K — [HF nu-dialogue/real-persona-chat](https://huggingface.co/datasets/nu-dialogue/real-persona-chat), [PACLIC 2023](https://preview.aclanthology.org/moar-dois/2023.paclic-1.85.pdf)
- Multi-session Twitter Dialogue Dataset（東大）: 日本語 Twitter の複数セッション会話。過去セッションを検索する retriever の訓練と評価に使う。配布はツイート ID のみ — [IWSDS 2023 page](https://www.tkl.iis.u-tokyo.ac.jp/~takasa-m/iwsds2023.html)
- 言語処理学会の発表（いずれも検索スニペットでのみ確認 [未検証]）
  - NLP2026 P4-21: 複数セッション雑談での人間関係を知識グラフとして扱い、関係の照会と関係の更新を課題にする — [ANLP 2026 P4-21](https://www.anlp.jp/proceedings/annual_meeting/2026/pdf_dir/P4-21.pdf)
  - NLP2025 P10-7: 日本語日常対話コーパスから、メモ検索とメモを使った応答生成のデータセットを作る — [ANLP 2025 P10-7](https://www.anlp.jp/proceedings/annual_meeting/2025/pdf_dir/P10-7.pdf)
  - NLP2026 B8-12: 日本語の長文脈評価ベンチマーク — [ANLP 2026 B8-12](https://www.anlp.jp/proceedings/annual_meeting/2026/pdf_dir/B8-12.pdf)
  - Japanese MT-bench++（約5,000対話。複数ターン評価で、長期記憶は対象外） — [ANLP 2025 D9-1](https://www.anlp.jp/proceedings/annual_meeting/2025/pdf_dir/D9-1.pdf)

### Inferences
- 日本語・音声主体の自社エージェントでは、既存ベンチマークの数値はそのまま使えない。LongMemEval の5能力の分類と、Memora / BEMULA の忘却・更新の設計を借りて、自前の日本語ケース集を作るのが現実的。
- 「回答不能なら棄権する」能力は、LoCoMo の慣行（cat.5 除外、回答を強制するプロンプト）では測れない。LongMemEval の abstention 型に相当する設問を、明示的に入れる必要がある。
- 実運用の会話が数か月にわたって窓を超える場合、BEAM の 1M〜10M の結果（長文脈モデルも劣化する）の方が、LoCoMo より設計判断の参考になる。

### Gaps
- PerLTQA・MemBench・LongBench・∞Bench の規模と指標は、今回は一次資料で確認していない。
- 日本語の長期記憶 QA（LoCoMo や LongMemEval 相当）の翻訳版や公開ベンチマークは見つからなかった。NLP2026 P4-21 の本文は PDF を読めず、関連研究の一覧を確認できなかった。

---

## Q2. 全文脈・RAG・記憶システム（Mem0, Zep, Letta, A-MEM, LangMem, OpenAI memory）の比較結果と数値の論争

### Takeaway
Mem0 論文の LoCoMo 比較では、全文脈（約26k tokens）の J=72.90 が Mem0（66.88）や Mem0g（68.44）を上回った。記憶システムの利点は精度ではなく、レイテンシ（p95 合計 17.1秒 → 1.4秒）とトークン量（26k → 1.8k）。ベンダー間の数値は、judge・回答モデル・カテゴリの扱い・top-k が揃っておらず比較できない。Zep の LoCoMo スコアは 84% → 75.14%（Zep 自身の訂正）／65.99%（Mem0 による測定）／58.44%（Mem0 CTO の再実行）と大きく割れている。

### Cited Findings
- **Mem0 論文 (arXiv 2504.19413, 2025-04) LoCoMo 全体 J (%, 10回の平均 ±SD)**: Full-context 72.90±0.19、Mem0g 68.44±0.17、Mem0 66.88±0.15、Zep 65.99±0.16、LangMem 58.10±0.21、OpenAI 52.90±0.14、A-Mem 48.38±0.15。最良の RAG（k=2、256 tokens）は 60.97±0.20 — [arXiv 2504.19413](https://arxiv.org/html/2504.19413)
- **同論文のレイテンシ（秒）と文脈トークン**
  - Full-context: 26,031 tokens、合計 p50 9.870 / p95 17.117
  - Mem0: 1,764 tokens、検索 p50 0.148 / p95 0.200、合計 p95 1.440
  - Mem0g: 3,616 tokens、合計 p95 2.590
  - Zep: 3,911 tokens、合計 p95 2.926
  - LangMem: 127 tokens だが検索 p95 59.82、合計 p95 60.40
  - OpenAI: 4,437 tokens、合計 p95 0.889
  - 出典 — [arXiv 2504.19413](https://arxiv.org/html/2504.19413)
- **同論文のカテゴリ別 J**: temporal は Mem0g 58.13、Zep 49.31、LangMem 23.43、OpenAI 21.71。multi-hop は Mem0 51.15、Zep 41.35 — [arXiv 2504.19413](https://arxiv.org/html/2504.19413)
- 同論文の judge モデル名は本文で明示されていない（gpt-4o-mini への言及のみ）。adversarial カテゴリは除外 — [arXiv 2504.19413](https://arxiv.org/html/2504.19413)
- **Zep の反論 (2025-05-06)**: Mem0 による Zep の評価には3つの誤りがあると主張。①両方の話者を user として登録した ②タイムスタンプを `created_at` ではなく本文に付けた ③検索を並列ではなく逐次で実行した。訂正後の Zep は J 75.14±0.17、検索 p95 0.632秒。全文脈ベースライン（約73%）が Mem0 を上回る点を、LoCoMo 自体の欠陥として挙げた — [Zep blog](https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
- **逆方向の指摘**: Zep が当初掲げた84%は、cat.5 を分子に入れて分母から外したため、約25ポイント水増しされていた。Mem0 CTO が Zep のパイプラインで再実行すると 58.44±0.20（10 seed） — [Bloo-mind essay](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/), [getzep/zep-papers issue #5](https://github.com/getzep/zep-papers/issues/5)。最終的な数値について二次資料の記述が食い違う — [Atlan: Zep vs Mem0](https://atlan.com/know/zep-vs-mem0/)
- **Letta (2025-08-12)**: LoCoMo の会話をファイルに置き、`grep` / `search_files` / `open` / `close` だけで GPT-4o-mini が 74.0%。Mem0g の 68.5% を上回った（ベンダー自身の測定） — [Letta blog](https://www.letta.com/blog/benchmarking-ai-agent-memory)
- **後年のベンダー数値**: Mem0 の新アルゴリズムは LoCoMo 92.5（旧 71.4）、LongMemEval 94.4（いずれもベンダー測定）。92.5 は答えキー誤りから見た上限（約93.6）付近 — [DEV (D'Erme)](https://dev.to/gde03/the-ai-memory-benchmark-everyone-quotes-forbids-saying-i-dont-know-o1n), [Atlan](https://atlan.com/know/zep-vs-mem0/)
- **自己申告と第三者再現の乖離**: EverMemOS は自己申告 92.32% に対し第三者再現 38.38%。MemPalace の「100%」は top-k=50、dev 設問向けの手書きパッチ、検索のみの指標によるもので、実質は LongMemEval R@5 96.6%、LoCoMo R@10 60.3%。LoCoMo の報告値は約54ポイントの幅に散らばる — [Bloo-mind essay](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)
- **LongMemEval の主な結果**
  - 商用アシスタント（97問の小規模調査）: ChatGPT (GPT-4o) 0.577（同じモデルでオフラインに読ませると 0.918）、Coze 0.330
  - 長文脈 LLM: GPT-4o は根拠セッションのみ（oracle）0.870 → _S 0.606（−30.3%）。他モデルは 36〜55% 低下
  - 出典 — [arXiv 2410.10813](https://arxiv.org/html/2410.10813)
- **LongMemEval の設計知見**
  - 値の粒度: セッションをラウンドに分割すると良い。抽出した事実を値にすると multi-session は改善するが、他の型は情報欠落で悪化
  - キーの拡張: 抽出した事実をキーに足すと recall@k +9.4%、正答率 +5.4%
  - 時間を考慮したクエリ拡張: temporal の recall が +11.3%（ラウンド値）／+6.8%（セッション値）。時間範囲の抽出に強い LLM（GPT-4o）が要り、Llama 3.1 8B では不調
  - 読み方: Chain-of-Note と JSON 形式で最大 +10 ポイント
  - 出典 — [arXiv 2410.10813](https://arxiv.org/html/2410.10813)
- **その他の比較**
  - Zep は LongMemEval_S で 71.2%（GPT-4o） — [Bloo-mind essay](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)
  - Mastra の observational memory は LongMemEval_S 84.23%（ベンダー報告。GPT-5-mini では 94.87%）、GPT-4o 全文脈は約60.2% — [同上](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)
  - MemoryBench では、Mem0・A-Mem・MemoryOS が全文脈を使う RAG ベースラインを一貫しては上回らない — [同上](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)
  - Memora の結論: 記憶エージェントの改善はわずか（"marginal"）で、失敗の主因は容量ではなく更新下での最新性の維持 — [arXiv 2604.20006](https://arxiv.org/html/2604.20006v1)
- 推奨（意見）: 全文脈と「ファイル＋grep」のベースラインを自社データで先に測り、10ポイント以上上回る場合だけ記憶システムを採用する。10 seed と2種の judge で評価し、10ポイント未満の差はノイズとみなす — [Bloo-mind essay](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)

### Inferences
- 短い会話の評価セットでは全文脈が強いベースラインになる。記憶設計の価値は、①窓を超える長さ ②レイテンシと費用 ③更新・忘却の正しさ、の3点で示す必要がある。音声主体なら応答レイテンシの p95 が特に重要。
- ベンダーの公表値は、judge・回答モデル・top-k・カテゴリ処理を自社で揃えて再測定しない限り、設計判断に使えない。
- 「ファイル＋grep」で 74% という結果は、単純な全文検索ベースラインを比較対象に必ず含めるべきことを示している。

### Gaps
- OpenAI memory、LangMem、A-MEM について、LoCoMo 以外での独立評価は見つからなかった。
- MemGPT/Letta 本体（記憶ブロック方式）の LoCoMo J 値は Mem0 論文の表 2 に載っていない（表 1 の F1 のみ）。
- 日本語での比較結果は一切見つからなかった。

---

## Q3. 忘却・削除の正しさ、更新の正しさ、能動的な振る舞い（既知の事実を聞き返さない）の評価と人手評価

### Takeaway
「最新の値を答えるか」と「古い値や削除した値を使わないか」は別の能力で、2026 年に後者を測るベンチマークが出てきた。BEMULA では、主要な記憶システムのどれも明示的な忘却依頼の 1.5% 超を端から端まで通過できず、対照群付き設計（対照版で保存できていたものだけを採点）が鍵になっている。能動性（聞き返しを避けること）の標準的な評価は見つからなかった。

### Cited Findings
- **BEMULA (arXiv 2610.18052, 2026-10)**
  - 5つの試験群: ①保存できたか ②依頼した情報が消えたか ③無関係な記憶が保たれたか ④類似の事実を再学習できるか ⑤抽出攻撃に耐えるか
  - 各対話に、忘却依頼を含まない対照版を用意する。対照版で保存できていた情報だけが、忘却の採点対象になる
  - 6つの主要記憶システム × 3つの基盤 LLM で、どのシステムも忘却依頼の端から端までの通過率は 1.5% 以下で、大半は0%。簡単な攻撃で抽出できてしまうか、依頼より大幅に多くを消すかのどちらか
  - 出典 — [arXiv 2610.18052](https://arxiv.org/abs/2610.18052)（対象システム名は abstract に記載がなく未確認）
- **Memora の FAMA**: FAMA = max(0, MPA − λ·(1 − FAA))
  - MPA: 「記憶があるべき」基準を満たした割合
  - FAA: 「忘却されているべき」基準を満たした割合
  - λ = N_forget / (N_presence + N_forget)
  - 最終的な答えが正しくても、古い記憶や削除済みの記憶を使えば減点する
  - 記憶エージェントの減点幅は 18.2（週次）→ 29.5（四半期）と、期間が長いほど拡大する（古い記憶の再利用）
  - 出典 — [arXiv 2604.20006](https://arxiv.org/html/2604.20006v1)
- 既存ベンチマークの更新評価は限定的: LongMemEval の knowledge update は最大2セッション、PersonaMem は3セッション以内 — [arXiv 2604.20006](https://arxiv.org/html/2604.20006v1)。LoCoMo には knowledge update の設問がない — [Zep blog](https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
- 検索スニペットで見た関連研究（いずれも [未検証]）
  - MemoryAgentBench の selective forgetting — [arXiv 2507.05257](https://arxiv.org/abs/2507.05257)
  - 13のシステム構成を比べる "Control-Plane Placement Shapes Forgetting"（385件の敵対的試験 ForgetEval-Adv） — [arXiv 2606.15903](https://arxiv.org/html/2606.15903)
  - プライバシー観点の忘却 FiFA — [arXiv 2512.12856](https://arxiv.org/abs/2512.12856)
  - 多モーダル記憶の情報漏洩 MemLeak — [arXiv 2606.29788](https://arxiv.org/pdf/2606.29788)
  - サーベイの評価「忘却をうまく評価している研究はない」 — [arXiv 2603.07670](https://arxiv.org/html/2603.07670v1)
- BEAM は contradiction resolution と instruction following（過去に受けた指示を守り続けるか）を能力として含む — [BEAM GitHub](https://github.com/mohammadtavakoli78/BEAM)
- 好みの反映（能動性に近い能力）: LongMemEval の single-session-preference 型 — [arXiv 2410.10813](https://arxiv.org/html/2410.10813)。Memora の recommending 課題（言語モデル平均 144.72〜153.34 に対し、記憶エージェントは 138.37） — [arXiv 2604.20006](https://arxiv.org/html/2604.20006v1)

### Inferences
- 明示的な記憶・忘却依頼の評価は、BEMULA の5群と対照版の方式をそのまま採るのが良い。ケース集の例:
  - 「覚えて」→ 後日の想起（保存）
  - 「忘れて」→ 直接質問・間接質問・言い換えでの抽出（削除）
  - 同じ会話内の無関係な事実（保持）
  - 「忘れて」の後で再び似た事実を言う（再学習）
- 背景の統合（consolidation）処理は、古い値が要約・統合の結果に残ることがある（Memora の減点幅が期間とともに拡大する現象）。そのため、統合の前と後の両方で FAMA 型の「不在」基準を検査する必要がある。
- 能動性は次の指標として自前で定義する必要がある。
  - 聞き返し率: 既知の事実を尋ねる発話の割合
  - 不要な想起の率: 文脈に合わない場面で記憶を持ち出す割合
  - 適切な想起の率

### Gaps
- 能動的な振る舞い（既知事実を聞き返さない、適切な場面で想起する）を測る確立したベンチマークや指標は見つからなかった。
- 個人アシスタントの人手評価の標準手順（評価者数、尺度、評価者間の一致率）について、一次資料を確認できなかった。MSC は人手評価を含むが、詳細は未確認。
- BEMULA で評価されたシステム名とシステム別の数値は未取得（本文または GitHub の確認が必要）。

---

## Q4. 実務の方法論: 固定ケース集、新旧の対比較、LLM-as-judge の信頼性、回帰の測定、サンプル数

### Takeaway
judge の信頼性はベンチマークによって大きく違う。LongMemEval の GPT-4o judge は人手と97%超一致する一方、LoCoMo の GPT-4o-mini judge は誤答の62.8%を正解にする。judge は「意図的に誤らせた回答」で較正する必要がある。報告値の差の多くは評価条件の違いから来ており、10ポイント未満の差を有意とみなすには、seed の反復・2種の judge・対比較の検定が要る。

### Cited Findings
- **judge の信頼性**
  - LongMemEval の GPT-4o judge は人手の専門家と97%超一致 — [arXiv 2410.10813](https://arxiv.org/html/2410.10813)
  - LoCoMo の標準 judge は、話題は合っているが誤った回答の62.81%を正解とした — [Bloo-mind essay](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)
  - LoCoMo-Refined の judge は人手との一致率が 43.67% → 86.33% に改善 — [同上](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)
  - LoCoMo の judge は、根拠を受理の方向にしか使えない（棄却には使えない） — [DEV (D'Erme)](https://dev.to/gde03/the-ai-memory-benchmark-everyone-quotes-forbids-saying-i-dont-know-o1n)
- **反復のばらつき**: Mem0 論文は全手法を10回独立に実行し、平均 ±1SD を報告。全体 J の SD は 0.14〜0.23 — [arXiv 2504.19413](https://arxiv.org/html/2504.19413)。複数 seed を報告したのは Mem0 だけで、他はほぼ1回の実行 — [Bloo-mind essay](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)
- **固定ケース集の汚染と自前化**
  - 独自の on-policy ベンチマークを作り、ベンダー変更時の関門にすることが推奨されている — [Bloo-mind essay](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)
  - AMemGym では、off-policy（固定ログの再生）と on-policy の順位が最大3位ずれる — [同上](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/), [arXiv 2603.01966](https://arxiv.org/abs/2603.01966)
- **検索段と回答段を分けた測定**
  - LongMemEval は検索（Recall@k、NDCG@k）と QA 正答率を別々に測る。oracle 検索でも読み方の工夫で最大 +10 ポイント — [arXiv 2410.10813](https://arxiv.org/html/2410.10813)
  - MemPalace の例のように、検索のみの指標（R@k）を QA 正答率として掲げると誤解を招く — [Bloo-mind essay](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)
- **公開ハーネスの差**: プロンプト（回答の強制）、許容幅（±14日など）、取得量の上限（最大200件、約7k tokens）がスコアを左右する — [DEV (D'Erme)](https://dev.to/gde03/the-ai-memory-benchmark-everyone-quotes-forbids-saying-i-dont-know-o1n)
- **答えキー自体の監査**: LoCoMo の6.4%誤りの例があり、ラベル誤りの一般論は Northcutt et al. — [arXiv 2103.14749](https://arxiv.org/abs/2103.14749)

### Inferences（統計上の一般論。出典なしの推論）
- **サンプル数**: 二値の正答率で n=500 なら、95% 信頼区間の半幅は p=0.5 で約 ±4.4 ポイント、n=200 で約 ±6.9 ポイント、n=100 で約 ±9.8 ポイント。新旧を比べるときは、同じケース集での対比較（McNemar 検定、または不一致ペア数に対する符号検定）にすると、独立2標本の比較より少ないケースで差を検出できる。能力ごとの小区分（例: 忘却 30件）は、区分単位では大きな回帰しか検出できない。
- **固定ケース集の構成案**（LongMemEval と BEMULA の組み合わせ）
  - 能力区分: 抽出 / 複数セッション推論 / 時間推論 / 更新 / 棄権 / 明示記憶 / 明示忘却 / 保持 / 再学習 / 聞き返し回避
  - 各ケースに持たせるもの: 「存在すべき事実」と「不在であるべき事実」（FAMA 型）、根拠ターンの ID（検索の Recall 計測用）
  - 日本語の音声入力を想定し、ASR 誤りを含む発話（同音異義語、固有名詞の表記ゆれ）も入れる
- **judge の運用**
  - 誤答（話題は合っているが誤り）、古い値での回答、削除済みの値への言及を含む較正セットを作り、judge の誤受理率を測る
  - judge は2種併用し、不一致のケースは人手で裁定する。judge のプロンプトとモデル版は固定し、記録する
- **回帰の判定**: 全体スコアに加えて、①区分ごとのスコア ②「新しく失敗したケース」の一覧（対比較の不一致ペア）③レイテンシ p95 と文脈トークン量、を毎回記録する。比較対象として、全文脈と単純検索（grep・BM25）のベースラインを常に同時に測る。
- **背景統合の評価**: 統合処理の前と後で、同じケース集を対比較する。統合で消えた事実（保持の失敗）と残った古い値（更新・忘却の失敗）を別々に数える。

### Gaps
- LLM-as-judge の日本語での信頼性（人手との一致率）を、記憶 QA で測った報告は見つからなかった。
- 記憶ベンチマークに特化した、必要サンプル数や検出力の分析を示す一次資料は見つからなかった（上記の数値は一般統計からの推論）。
- 音声主体（ASR 誤りを含む入力）での記憶評価の先行例は見つからなかった。
