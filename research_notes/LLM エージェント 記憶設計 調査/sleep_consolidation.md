# 睡眠様オフライン記憶統合（sleep-like offline memory consolidation）: 神経科学理論と常駐 LLM エージェントへの適用

調査日: 2026-11-22。表記ルール:
- 「確立」= 査読論文で繰り返し支持されている所見
- 「仮説」= 提案段階の理論、または反証や再現失敗がある所見
- 「未検証」= 本調査で一次資料を開いて確かめていない項目（DOI・数値を既有知識から書いたもの）
- arXiv 2026 年の論文はすべて v1/v2 のプレプリントで、査読前

---

## 1. 相補的学習システム（CLS）理論、標準統合 vs 多重痕跡／痕跡変換、スキーマ依存統合

### Takeaway
CLS 理論では、海馬が個別の経験を速く疎に記録し、新皮質がそれをゆっくり、他の記憶と交互に（interleaved）学習して構造化された知識にする。速い一括書き込みは既存知識を壊す（破滅的干渉）ので、二系統に分ける。ただし Tse 2007 は、既存スキーマに合う情報なら新皮質への統合が 48 時間以内で済むことを示し、「統合は常に遅い」という前提を修正した。LLM エージェントに当てはめると「生エピソードの即時保存＋遅いオフライン統合」の二層構成になり、新情報が既存の要約・人物像に合うかどうかで統合の速さや経路を変える根拠になる。

### Cited Findings
- **CLS 原典（確立）**: McClelland, McNaughton & O'Reilly (1995) "Why there are complementary learning systems in the hippocampus and neocortex", *Psychological Review* 102(3):419–457。新皮質型の分散ネットワークに新しい項目を集中して学習させると、既存知識が破滅的に干渉される。海馬に一旦保存し、旧知識と交互に再生（interleaved replay）してゆっくり学習させれば干渉を避けられる、と論じた。— DOI [10.1037/0033-295X.102.3.419](https://doi.org/10.1037/0033-295X.102.3.419)（未検証: DOI は既有知識。本調査では本文を開いていない）
- **CLS 更新版（確立／レビュー）**: Kumaran, Hassabis & McClelland (2016) "What Learning Systems do Intelligent Agents Need? Complementary Learning Systems Theory Updated", *Trends in Cognitive Sciences* 20:512–534、2016-06-14 オンライン公開。新皮質は環境の構造化知識をゆっくり獲得し、海馬は個別経験を速く保存する。更新版は海馬の役割を 1995 年版より広げ、AI エージェント設計（DQN の experience replay など）との関連を明示した。— DOI 10.1016/j.tics.2016.05.004、[Stanford PDF](https://web.stanford.edu/~jlmcc/papers/KumaranHassabisMcClelland16FinalMS.pdf), [ScienceDaily](https://www.sciencedaily.com/releases/2016/06/160614133609.htm)
  - 更新版の要点として広く知られている次の 3 点は、本調査で本文を確認していない（未検証）: (a) 海馬の再生は報酬や重要度に応じて偏らせて（prioritized replay）よい。(b) スキーマに合う情報は新皮質へ速く統合されうる。(c) DQN の experience replay は CLS の工学版である。
- **スキーマ依存統合（確立）**: Tse et al. (2007) "Schemas and Memory Consolidation", *Science* 316:76–82。ラットに味と場所の対応 6 組を数週間かけて学習させ、スキーマを作った。その後、新しい 2 組を 1 試行だけ学習させ、48 時間後に海馬を除去しても記憶は残った。学習 3 時間後の除去では記憶が失われた。既存スキーマがあると、システム統合は極めて速く進む。— [PubMed 17412951](https://pubmed.ncbi.nlm.nih.gov/17412951/), [PMC2271071 (commentary)](https://pmc.ncbi.nlm.nih.gov/articles/PMC2271071)
  - 被験動物について資料間で食い違いがある。Alzforum の記事は「マウス」としているが、原論文と他の解説は「ラット」。ラットが正しい。— [Alzforum](https://alzforum.org/node/36083)
- **標準統合理論 vs 多重痕跡理論（MTT）／痕跡変換理論（理論対立。決着していない）**:
  - 標準モデル: 記憶は最終的に海馬から独立し、新皮質だけで想起できるようになる。Klinzing ら 2019 の「海馬依存の表象が睡眠中に新皮質へ再分配される」という能動的システム統合モデルも、この系譜に入る。— [Klinzing et al. 2019](https://doi.org/10.1038/s41593-019-0467-3)
  - MTT（Nadel & Moscovitch 1997, *Curr Opin Neurobiol* 7:217–227）: 詳細なエピソード記憶は想起のたびに海馬痕跡が増え、生涯にわたって海馬に依存する。海馬から独立するのは意味化（semantic）した要旨だけである。痕跡変換理論（Winocur & Moscovitch 2011）は、詳細なエピソードと要旨（gist）が併存し、統合とは「変換」だと主張する。— DOI 10.1016/S0959-4388(97)80010-4（未検証: 書誌は既有知識。本調査では一次資料を開いていない）
  - Klinzing らのレビューは、睡眠中の記憶変換によって抽象化された要旨的な表象ができると明記している。これは変換の見方と整合する。— [Nature Neuroscience 2019 (DOI 10.1038/s41593-019-0467-3)](https://www.nature.com/articles/s41593-019-0507-z)（訂正記事 10.1038/s41593-019-0507-z あり）

### Inferences
- LLM 記憶に置き換えると、標準モデルは「要約ができたら生ログを捨てる」、MTT／痕跡変換は「要旨を作っても詳細エピソードは残し、要旨から参照する」になる。後者は、§3 の「統合を繰り返すと記憶が劣化する」という実証（Zhang et al. 2026）とも合う。設計としては後者を採るのが妥当と考える。
- Tse 2007 を設計に写すと「既存の人物像・トピックに合う新事実は即時に統合してよく、既存知識と矛盾する、あるいは新規の事実は生エピソードとして保持し、複数回の観測を待ってから統合する」となる。これは推論で、LLM エージェントで実証した研究は見つけていない。
- 交互再生は重み学習（fine-tuning）での干渉対策である。テキスト記憶（RAG・memory block）では、重みを更新しないため干渉の機構が違う。テキスト記憶での主な危険は「上書き要約による情報損失・歪み」で、破滅的干渉そのものではない。

### Gaps
- Kumaran 2016 本文の prioritized replay とスキーマ節は、本調査では本文を開いていない。
- MTT と標準モデルのどちらが正しいかは、ヒトの遠隔記憶研究でも決着していない（未検証。レビュー本文を開いていない）。

---

## 2. 睡眠段階の役割: SWR と NREM 再生、シナプス恒常性仮説、REM と抽象化・創造性、能動的忘却、情動・重要度による選択的統合

### Takeaway
確立している所見: NREM 睡眠中の海馬鋭波リップル（SWR）に伴う再生が、徐波・紡錘波と時間的に結びつき、海馬から新皮質への能動的なシステム統合を担う。睡眠は要旨化・規則抽出も促す。シナプス恒常性仮説（SHY）は、睡眠を全体的な重みの下方調整（down-selection、忘却）の時間とみなす。仮説・論争中の所見: REM と創造性の関係は弱い証拠しかなく、「将来役に立つと予期した記憶を睡眠が選んで強化する」効果には再現失敗がある。工学的には「統合（再生・抽象化）」と「刈り込み（全体の減衰）」を別の操作として持つことが、生物学から引き出せる最も堅い示唆である。

### Cited Findings
- **能動的システム統合（確立／レビュー）**: Klinzing, Niethard & Born (2019) "Mechanisms of systems memory consolidation during sleep", *Nature Neuroscience* 22、2019-08-26 オンライン公開。主にヒトとげっ歯類の神経生理・行動データをまとめたレビュー。睡眠中の長期記憶形成を能動的なシステム統合とみなす。睡眠中の振動（徐波・紡錘波・リップル）がネットワーク間の情報の流れと局所の可塑性を制御し、記憶は抽象化された要旨的な表象に変換される、とする。— [DOI 10.1038/s41593-019-0467-3](https://link.springer.com/article/10.1038/s41593-019-0467-3)
- **睡眠と記憶の総説（確立）**: Diekelmann & Born (2010) "The memory function of sleep", *Nature Reviews Neuroscience* 11:114–126。徐波睡眠中に海馬依存の記憶が再活性化され、新皮質へ再分配されるという能動的システム統合の枠組みを示した。— DOI [10.1038/nrn2762](https://doi.org/10.1038/nrn2762)（未検証: 書誌は既有知識）
- **SWR 妨害実験（確立）**: Girardeau et al. (2009, *Nature Neuroscience* 12:1222–1223)。学習後の睡眠中に SWR を選んで妨害すると、空間記憶の固定が損なわれた。SWR と記憶固定の因果を示す古典的研究。— DOI 10.1038/nn.2384（未検証: 書誌は既有知識）
- **シナプス恒常性仮説 SHY（有力な仮説。支持と反論の両方がある）**: Tononi & Cirelli (2014) "Sleep and the price of plasticity: from synaptic and cellular homeostasis to memory consolidation and integration", *Neuron* 81(1):12–34（2014-01-08）。睡眠中の自発活動が覚醒中に強まったシナプス強度を全体として正規化し、細胞の恒常性を回復する。強いシナプスはエネルギー消費の増加と S/N 比の低下を招き、放置すると学習が飽和する、と論じる。— [PubMed 24411729](https://pubmed.ncbi.nlm.nih.gov/24411729/), [PMC3921176](https://pmc.ncbi.nlm.nih.gov/articles/3921176/)
  - 2019 年の続報 "Sleep and synaptic down-selection" は、調節されている変数は発火率ではなくシナプス強度だとする。— [PMC6612535](https://pmc.ncbi.nlm.nih.gov/articles/PMC6612535)
  - SHY と能動的システム統合の関係（睡眠の主役は再生による強化か、全体の減衰による選択か）は論争中。両立させる見方もある（未検証: 本調査では対立レビューを開いていない）。
- **NREM は規則抽出、REM は遠い連合（仮説）**: Lewis, Knoblich & Poe (2018) "How Memory Replay in Sleep Boosts Creative Problem-Solving", *Trends in Cognitive Sciences* 22(6):491–503。NREM の再生は学習した素材の集まりから規則を抽出し、REM の再生は創造的問題解決に必要な予期しない飛躍を支える、という枠組み。— [Cardiff ORCA PDF](https://orca.cardiff.ac.uk/111453/1/Lewis.%20How%20memory%20replay.pdf), [PMC6843748](https://pmc.ncbi.nlm.nih.gov/articles/PMC6843748)
  - 反論・留保: 2026 年の *Neuroscience of Consciousness* のレビューは、REM と創造性の結びつきは逸話的な支持しかなく、厳密な研究による強い実証がないと述べる。— [OUP 2026 niaf067](https://academic.oup.com/nc/article/2026/1/niaf067/8456489)
  - 関連実験: Sanders, Paller ら (2019, *Psychological Science*) は、睡眠中にパズルの手がかりを提示すると解決率が上がることを示した。睡眠段階を REM に限定した実験ではない。— [Northwestern PDF](https://faculty.wcas.northwestern.edu/paller/PsychSci2019.pdf)
- **将来の関連性による選択的統合（論争中）**: Wilhelm et al. (2011) *J Neurosci* 31(5):1563–1569 は、後でテストされると予期しただけで、睡眠による記憶の固定が有意に強まると報告した（2 実験、計 191 名）。効果は徐波活動・紡錘波数と相関し、相関はテストを予期した群でだけ見られた。— [PubMed 21289163](https://pubmed.ncbi.nlm.nih.gov/21289163/)
  - 再現失敗: Ashton & Cairney (2021, *PLOS ONE*) "Future-relevant memories are not selectively strengthened during sleep" は、オンライン追試の 2 実験とも効果を確認できなかった。— [PMC8568116](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8568116/)。2016 年の別グループの *PLOS ONE* 研究も仮説を支持しなかった。— [PMC5070851](https://pmc.ncbi.nlm.nih.gov/articles/PMC5070851)
  - 2023 年の *Frontiers in Sleep* は Wilhelm らを、なお支持する研究として挙げている。— [doi 10.3389/frsle.2023.1187170](https://doi.org/10.3389/frsle.2023.1187170)
- **情動・報酬による優先的統合、能動的忘却**: 情動価の高い記憶や報酬と結びついた記憶が睡眠中に優先して固定される、という報告は多い。本調査では一次資料・レビューを開いていない（未検証）。
- **「夢は過学習を防ぐ」仮説（仮説）**: Hoel (2021) の overfitted brain hypothesis は、夢が再生する経験を歪めることで、直近の経験への過学習を防ぐとする（*Patterns*, DOI 10.1016/j.patter.2021.100244。DOI は未検証）。LLM での検証は §3 の Zou 2026 を参照。— 仮説の要約は [arXiv 2611.21648](https://arxiv.org/abs/2611.21648) の背景節による

### Inferences
- 確立度の高い順に並べると、睡眠中の再活性化と能動的統合、睡眠による要旨化・規則抽出、SHY（全体の減衰）、重要度・将来の関連性による選択、REM と創造性の順になる。設計で頼るのは上位 2〜3 項目にとどめ、「将来使うものを選んで残す」や「夢で新しい連想を作る」は実験的な機能として扱うのが妥当。
- SHY の工学的な読み替え: 統合パスとは別に、全記憶の重要度・強度を一律に少し下げ、閾値を下回ったものを検索対象から外す（削除ではなく降格）パスを持つ。生物では S/N 比の回復が目的とされ、LLM では検索ノイズとコンテキスト長の抑制がこれに当たる。
- 「NREM は規則抽出、REM は遠い連合」は、統合ジョブを 2 種類に分ける発想として使える。1 つは同一トピック内の重複統合と規則化で、保守的な操作。もう 1 つはトピック横断の関連付けや仮説生成で、生成的な操作なので出力を「仮説」ラベル付きで隔離する。後者は生物学的根拠が弱い。

### Gaps
- 情動・報酬による選択的統合と、能動的忘却（例: ドーパミン依存の忘却、REM と忘却）のレビューは、本調査の呼び出し回数の上限内では開けなかった。
- SHY と能動的システム統合を直接比較したレビュー（両立説）は未確認。

---

## 3. AI での類比: experience replay／generative replay、Sleep-time compute、Letta sleep-time agents、Generative Agents の reflection、MemoryBank の忘却曲線、LLM エージェントの睡眠・統合・夢の研究

### Takeaway
連続学習では、replay（実データ再生・生成再生）が CLS の直接の工学版として定着している。LLM エージェントでは、Sleep-time compute（Lin et al. 2025）と Letta の sleep-time agent が「アイドル時に文脈を前処理して learned context を作る」形を実用化した。2026 年には、CLS を明示的に名乗るオフライン統合器（Auto-Dreamer、強化学習で学習）、検索フィードバックによる再固定化（REALM）、夢の仮説の検証（Zou）が出た。一方で「LLM に記憶を繰り返し書き換えさせると、有用性がいったん上がった後に劣化し、記憶なしより悪くなりうる」という強い反証（Zhang et al. 2026）もある。生エピソードを第一級の証拠として残し、統合の実行を明示的な条件で制限することが、現時点で最も支持されている設計である。

### Cited Findings
#### 連続学習の replay
- **Brain-inspired replay（確立。査読済み）**: van de Ven, Siegelmann & Tolias (2020) *Nature Communications* 11:4069。生成再生はデータを保存せずにクラス増分学習を解ける唯一級の方法だが、規模を大きくするのが難しかった。入力そのものではなく、文脈で変調したフィードバック結合から内部表象を生成して再生する方式で、CIFAR-100 や 100 超の逐次タスクで SOTA を達成した。— [DOI 10.1038/s41467-020-17866-2](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7426273/), [code](https://github.com/GMvandeVen/brain-inspired-replay)
  - 査読ファイルには、神経科学的な位置づけと実験範囲への批判が残っている。— [Springer peer review file](https://media.springernature.com/original/springer-static/esm/art%3A10.1038%2Fs41467-020-17866-2/MediaObjects/41467_2020_17866_MOESM2_ESM.pdf)
- 生成再生の原典は Shin et al. 2017 "Continual Learning with Deep Generative Replay"（arXiv 1705.08690）。— [arXiv](https://arxiv.org/abs/1705.08690)（未検証: 本調査では開いていない）

#### Sleep-time compute（Letta / UC Berkeley）
- **論文**: Lin, Snell, Wang, Packer, Wooders, Stoica, Gonzalez, "Sleep-time Compute: Beyond Inference Scaling at Test-time", arXiv 2504.13171、2025-04-17。クエリが来る前にオフラインで文脈について考え、来そうな質問を予測して中間結果を前計算しておくことで、テスト時の計算を減らす。— [arXiv](https://arxiv.org/abs/2504.13171)
  - Stateful GSM-Symbolic と Stateful AIME で、同じ精度を約 5 倍少ないテスト時計算で達成した。
  - sleep-time 計算を増やすと、精度は Stateful GSM-Symbolic で最大 +13%、Stateful AIME で最大 +18% 上がった。
  - Multi-Query GSM-Symbolic（同じ文脈に関連質問が複数ある設定）では、前計算を償却することで 1 クエリあたりの平均コストが 2.5 倍下がった。
  - **ユーザーのクエリがどれだけ予測可能かが、効果の大きさと強く相関する。**
  - エージェント型ソフトウェア開発タスクでの事例研究もある（abstract ではタスク名不明。「SWE-Features」という名称は未検証）。
- **Letta ブログ（2025-04-21）**: sleep-time を有効にすると、Letta は primary agent と sleep-time agent の 2 つを作る。— [Letta blog](https://letta.com/blog/sleep-time-compute)
  - primary は会話・ツール実行・recall/archival の検索を担い、core memory を編集できない。core memory の編集ツールは sleep-time agent だけが持つ。
  - sleep-time agent は「anytime」方式で primary の memory を書き換える。primary は完了を待たずにいつでも memory を読める。
  - raw context を learned context に変換する。MemGPT 原設計の逐次的な記憶形成より、整った簡潔な記憶になると主張している。
  - アップロード文書も裏で読み、要点を primary の memory に書く。
  - 実行頻度は設定できる。頻度を上げるとトークン消費が増え、learned context を見直す機会も増える。
  - 遅延の制約が緩いため、sleep-time 側に強く遅いモデルを推奨している（例: primary に gpt-4o-mini、sleep-time に gpt-4.1 / Sonnet 3.7）。
- **Letta docs**: SDK フラグは `enable_sleeptime`。learned context は memory block に書かれ、複数のエージェントで共有できる。既定の memory persona block が「会話に応じて記憶を統合・更新せよ」と指示する。docs は機能を experimental と明記している。— [Letta docs (search snippet)](https://docs.letta.com/guides/agents/architectures/sleeptime/index.md), [Letta memory blocks](https://letta.com/blog/memory-blocks), [Letta forum: persona block](https://forum.letta.com/t/optimizing-memory-persona-block/113)
  - docs ページは WebFetch で 404 になり、検索の抜粋でしか確認できていない。「N ステップごとに起動、既定値 5（`sleeptime_agent_frequency`）」はうろ覚えで、未検証。

#### Generative Agents の reflection と MemoryBank
- **Generative Agents（Park et al. 2023, arXiv 2304.03442）**: 最近知覚した出来事の重要度スコアの合計が 150 を超えると reflection（高次の抽象化）を生成する。実際の頻度は 1 エージェントあたり 1 日 2〜3 回だった。LangChain の実装では `reflection_threshold` という設定値になっている。— [arXiv PDF](https://arxiv.org/pdf/2304.03442), [LangChain API](https://python.langchain.com/api_reference/experimental/generative_agents/langchain_experimental.generative_agents.memory.GenerativeAgentMemory.html)
  - 重要度（1–10 を LLM が採点）× 新しさ（指数減衰）× 関連度で検索する、という式の細部は本調査で再確認していない（未検証）。
- **MemoryBank（Zhong et al., arXiv 2305.10250、2023、AAAI 2024）**: Ebbinghaus の忘却曲線に着想を得た記憶更新機構を持つ。— [arXiv](https://arxiv.org/abs/2305.10250)、survey による言及 [arXiv 2501.04040](https://arxiv.org/pdf/2501.04040)
  - 具体式は未検証。保持率 R = e^(−t/S)、想起されると S を +1 して t をリセット、R が下がった記憶を忘れる、と記憶しているが、PDF のテキストを抽出できず確認できていない。

#### 2025–2026 の睡眠・統合・夢を明示する LLM エージェント研究（すべてプレプリント）
- **Auto-Dreamer（arXiv 2605.20616、2026-05-20）**: Ye, Liu, Wang, Yu, Zhao, Liu, McAuley, You。— [arXiv](https://arxiv.org/abs/2605.20616)
  - CLS に着想を得て、セッション内の速い記憶獲得と、セッション横断の遅い統合を分ける。
  - 型付き memory bank から領域を選び、その領域を読み取り専用の証拠として扱う。上限付きのツール呼び出しで、エントリとそれに紐づく元の軌跡を調べる。
  - 調べた結果から、セッション横断で抽象化したコンパクトな記憶集合を書き、元の領域と置き換える。狙いは繰り返しのパターンの発見、共通手順の抽象化、冗長エントリの刈り込み。
  - 統合器は GRPO で訓練し、エンドツーエンドのエージェント性能を報酬にする。訓練は ScienceWorld のみ。
  - 結果: ScienceWorld で固定・RL・プロンプト型の記憶ベースラインを 7 ポイント上回り、active memory bank は最強ベースラインの 1/12。ALFWorld でも 1/6 の記憶量で首位。WebArena でも首位だが、数値は abstract にない。
- **"Useful Memories Become Faulty When Continuously Updated by LLMs"（arXiv 2605.12978、v1 2026-05-13、v2 2026-08-29）**: Zhang, Lin, Wu, Sun, Li, Li, Peng。— [arXiv](https://arxiv.org/abs/2605.12978)
  - 統合した記憶の有用性は、いったん上がった後に劣化し、記憶なしの水準を下回りうる。
  - 正解解法から統合した場合でも、GPT-5.4 は記憶なしで解けていた ARC-AGI 問題の 54% を解けなくなった。
  - 劣化の原因は経験ではなく統合の工程にある。同じ軌跡でも、更新スケジュールが違えば違う記憶になる。
  - 生の軌跡を保存するだけの対照は、検証したどの統合器とも互角だった。
  - Retain/Delete/Consolidate の 3 行動を持つ ARC-AGI Stream 環境では、生エピソードを既定で保持するエージェントの精度が、強制統合するエージェントの 2 倍だった。
  - 提言: raw episodes を第一級の証拠として扱う。統合は毎回走らせず、明示的な条件で制限する。後の判断が頼る証拠を統合が上書きしないよう管理する。append-only という語は論文にはない。
- **REALM（arXiv 2609.16053、2026-09-13）**: Song ら、検索駆動の記憶再固定化（memory reconsolidation）。— [arXiv](https://arxiv.org/abs/2609.16053)
  - 記憶を異種の認知グラフに自律的に組織し、検索フィードバックに基づいて継続的に再固定化する。
  - 平均精度は LoCoMo 75.97%（+7.17 pt）、LongMemEval 65.11%（+1.31 pt）。アブレーションでは、再固定化を入れると一貫して性能が上がった。
  - 再固定化により、関連する記憶単位がまとまった局所構造に再編される。
  - 想起後に記憶が不安定になる時間窓（labile window）や、具体的な更新規則は abstract に書かれていない。
- **"Can an LLM dream?"（arXiv 2611.21648、2026-10-14、Eric Zou、単著）**: overfitted brain hypothesis を検証した。— [arXiv](https://arxiv.org/abs/2611.21648), code github.com/EricJujianZou/llm-dream
  - 設定: Claude Opus 5.5 のエージェントが、毎晩その日の会話記録からテキスト記憶を書き直す。LongMemEval から作った 10 日分を使う。書き直しの前に、記録の 5/10/20/40% のターンを破損させた。
  - 破損は 2 種類: 細部を間違った値に差し替える破損と、Moby-Dick の文で置き換えるランダム文の破損。
  - 記憶量の上限（19.5k → 117k tokens）で忘却を強制した。計 30 run。
  - 結果: どの run でも、破損は過去の学習を新しい課題に使う能力を改善しなかった。細部差し替え 40% で再生率は 76% → 60%。ランダム文はほぼ影響なし（0±2 pt）で、モデルが破損と見抜いて捨てたとみられる。
  - **差し替えた細部は、別のターンに正しい値があっても事実として記憶に入った**。該当問題の正答率は 40%（破損なしでは 75%）。
- 名前だけ確認し、中身を読んでいない関連研究（未検証）:
  - TiMem（時間階層的な記憶統合、[arXiv 2601.02845](https://arxiv.org/pdf/2601.02845)）
  - The Sleeping Agent（要旨圧縮で失われるもの、[arXiv 2608.11775](https://arxiv.org/pdf/2608.11775)）
  - AI Meets Brain（認知神経科学から見たエージェント記憶のサーベイ、[arXiv 2512.23343](https://arxiv.org/pdf/2512.23343)）
  - Active Dreaming Memory（失敗をきっかけに睡眠様の統合を行い、学習した規則を反実仮想で検証する。engrXiv のプレプリント、[engrxiv](https://engrxiv.org/preprint/download/5919/9826)）
  - Phasor Agents（[arXiv 2601.04362](https://arxiv.org/pdf/2601.04362)）
  - Memory-Centric Continual Learning（[arXiv 2610.29357](https://arxiv.org/pdf/2610.29357)）
  - Remembering More, Risking More（記憶を持つエージェントの長期的な安全リスク、[arXiv 2605.17830](https://arxiv.org/pdf/2605.17830)）
  - Memory for Autonomous LLM Agents（サーベイ、[arXiv 2603.07670](https://arxiv.org/pdf/2603.07670)）

### Inferences
- 研究の系譜は 3 本ある。(1) 前計算型: Sleep-time compute と Letta。将来のクエリに備えて文脈を消化する。(2) 再構成型: Auto-Dreamer と Generative Agents の reflection。記憶を抽象化・圧縮する。(3) 検索駆動の再編型: REALM。使われた記憶を組み替える。(1) は「答えを速くする」、(2) と (3) は「記憶を良くする」が目的で、評価指標も違う。
- Zhang 2026 と Zou 2026 から導ける共通の危険: LLM による書き換えは、もっともらしい誤りを事実として固定しやすく、反復するほど累積する。統合結果で生記録を置き換える（Auto-Dreamer の replace 方式）場合は、元の軌跡へのリンクを残すことが前提になる。Auto-Dreamer も元の軌跡を読み取り専用の証拠として参照している。
- Generative Agents の「重要度の合計が閾値を超えたら起動」は、量に基づく起動条件として最も単純な実装例である。Letta は頻度（ステップ数）で起動する。Sleep-time compute の分析は「クエリが予測できるときに効く」ことを示しており、常駐の対話エージェントでは、話題が続く見込みのあるもの（進行中の作業、繰り返し出る人物・予定）に前計算を絞る根拠になる。

### Gaps
- Letta docs の正確な起動頻度の既定値（404 で取得できなかった）。
- MemoryBank の正確な更新式。
- Auto-Dreamer の WebArena の数値と、評価指標の正確な定義。
- REALM の更新規則の詳細。
- 生のログを残す設計と要約で置き換える設計を、同じ条件・長期間で比べた LLM 研究は Zhang 2026 以外に見つからなかった。

---

## 4. 設計パラメータ: 起動条件、実行する操作、安全性（新事実の幻覚防止・出所保持）、コスト

### Takeaway
文献から直接言える範囲は次のとおり。
- 起動条件: 量（重要度の合計、Park）、頻度（Letta）、アイドル時間（Lin/Letta の前提）。
- 操作: 重複統合・抽象化・刈り込み（Auto-Dreamer）、前計算（Lin）、検索フィードバックによる再編（REALM）、強度の減衰（MemoryBank、SHY の類比）。
- 安全性: 生エピソードの保持と統合の明示的な制限（Zhang）、元の軌跡を読み取り専用の証拠として参照すること（Auto-Dreamer）。
- コスト: 頻度を上げるとトークンが増える（Letta）。クエリが予測できるほど前計算の元が取れる（Lin、1 クエリあたり 2.5 倍の削減）。

以下の推奨表は、これらの所見からの推論である。

### Cited Findings
- 起動: 重要度スコアの合計が 150 を超えたら reflection（約 2〜3 回/日）— [Park et al. 2023](https://arxiv.org/pdf/2304.03442)
- 起動: 頻度は設定可能で、上げるとトークン消費と見直しの機会が増える — [Letta blog 2025-04-21](https://letta.com/blog/sleep-time-compute)
- 起動の制限: 毎回の統合は有害になりうるので、統合は明示的な条件で制限する — [Zhang et al. 2026](https://arxiv.org/abs/2605.12978)
- 操作: 繰り返しのパターンの発見、共通手順の抽象化、冗長エントリの刈り込み。範囲を選んで読み取り専用の証拠とし、上限付きのツール呼び出しで元の軌跡を確認する — [Auto-Dreamer 2026](https://arxiv.org/abs/2605.20616)
- 操作: 予測されるクエリへの中間結果の前計算 — [Lin et al. 2025](https://arxiv.org/abs/2504.13171)
- 操作: 検索で使われた記憶の再固定化と局所構造化 — [REALM 2026](https://arxiv.org/abs/2609.16053)
- 操作: 忘却曲線による減衰（MemoryBank、式は未検証）— [arXiv 2305.10250](https://arxiv.org/abs/2305.10250)
- 操作の生物学的根拠: 再生による統合と要旨化 — [Klinzing 2019](https://doi.org/10.1038/s41593-019-0467-3)。全体の下方調整 — [Tononi & Cirelli 2014](https://pubmed.ncbi.nlm.nih.gov/24411729/)
- 安全性: 統合のたびに誤りが入り、劣化は累積しうる。同じ経験でもスケジュール次第で別の記憶になる — [Zhang 2026](https://arxiv.org/abs/2605.12978)
- 安全性: 書き換えの入力にもっともらしい誤りが含まれると、正しい値が他にあっても誤りが記憶に定着する — [Zou 2026](https://arxiv.org/abs/2611.21648)
- 構成: 会話する agent と記憶を編集する agent を分け、編集権限は後者だけに与える。読み出しは待たない（anytime）。裏の agent には強いモデルを使ってよい — [Letta blog](https://letta.com/blog/sleep-time-compute)
- コスト: 前計算の償却で、1 クエリあたりのコストが 2.5 倍下がる。テスト時の計算は同じ精度で約 1/5 — [Lin 2025](https://arxiv.org/abs/2504.13171)

### Inferences
文献を常駐エージェント向けに組み立てた推奨案で、検証済みではない。

| 項目 | 推奨 | 根拠 |
|---|---|---|
| 記憶の層 | L0 生エピソード（追記専用・削除しない）→ L1 統合記憶（事実・要旨・手順）→ L2 特性・スキーマ（人物像・好み） | CLS、MTT／痕跡変換、Zhang 2026 |
| 起動条件 | 次の 3 つをすべて満たすとき: (a) 利用者のアイドル時間が閾値以上、(b) 前回統合以降の新しいエピソードの重要度の合計が閾値以上、(c) 前回の統合から最低間隔が経過 | Park、Letta、Zhang（毎回走らせない） |
| 実行単位 | トピック・人物ごとの領域を選び、領域単位で処理する。1 回あたりのツール呼び出しとトークンに上限を設ける | Auto-Dreamer |
| 操作 A（保守的） | 重複の統合、同じ事実の言い換えをまとめる、時系列の更新（旧値は履歴へ） | Klinzing（要旨化） |
| 操作 B（抽象化） | 複数エピソードに繰り返し現れるパターンだけを L2 に昇格させる。単発の出来事は昇格させない | Tse（スキーマ）、Auto-Dreamer |
| 操作 C（矛盾） | 自動では解決せず、両方の出所を付けて「未解決」として保持し、会話で確認する候補にする | Zou（誤りの定着） |
| 操作 D（減衰） | 統合とは別のパスで、全記憶の強度を一律に少し下げる。検索で使われたものは強化する。閾値を下回ったものは検索対象から外す（L0 は消さない） | SHY、MemoryBank、REALM |
| 操作 E（前計算） | 進行中の作業・予定など、話題が続く見込みの高いものだけ要点を準備する | Lin（予測可能性との相関） |
| 操作 F（生成的連想） | 既定では無効。有効にする場合も出力に「仮説」ラベルを付け、事実層には入れない | Lewis 2018 は根拠が弱く、Zou では効果なし |
| 出所 | L1/L2 の各項目に、元の L0 エピソードの ID 一覧と統合を実行した run の ID を必須で付ける。出所のない主張は書き込みを拒否する | Auto-Dreamer（証拠参照）、Zhang |
| 検証 | 統合の前後で、固定した想起質問セットの正答率を比べる。劣化したら統合結果を採用しない（L0 があれば巻き戻せる） | Zhang（いったん上がった後の劣化） |
| 権限 | 会話の経路は記憶を読むだけにし、書き込みは統合ワーカー 1 つに限る | Letta |
| コスト | 統合の頻度はトークン予算で上限を決める。前計算は利用頻度が高い対象に限る | Letta、Lin |

- 「幻覚で新事実を作らない」ための最小条件: 統合の出力は、入力エピソードの中に根拠がある主張だけにする（各主張に根拠エピソード ID を付ける）。そのうえで、根拠と主張が整合するかを別の呼び出しで点検する。点検に別呼び出しを使う方法を検証した研究は見つけていない（推論）。

### Gaps
- 起動閾値（アイドル何分、重要度の合計いくつ）の実証的な最適値を示した研究は見つからなかった。Park の 150 は 1 つの実装の値にすぎない。
- 統合 1 回あたりのトークンコストを報告した常駐エージェントの実測は見つからなかった。Lin は相対値（倍率）だけを報告している。
- 「生エピソードの保持」と「プライバシーや保存容量の都合による削除」の兼ね合いを扱った研究は、本調査では見つからなかった。
