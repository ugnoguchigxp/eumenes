# 記憶の常時注入 vs 取得、および能動型エージェントのユーザーモデル（調査ノート）

調査日: 2026-11-22。各項目に URL を付す。「未検証」は一次資料の本文で確認できていない記述（abstract のみ、二次資料のみ、または調査者の既知知識）を示す。

## (A1) 主要システムは何を常時注入し、何を取得に回しているか（MemGPT/Letta、ChatGPT、Claude）

### Takeaway
三方式に分かれる。Letta は「小さく上限付きのコアブロックを常時注入し、大きな保管庫はツール検索」。ChatGPT は「プロファイルと過去会話の要約を毎回自動注入（モデルに取得判断をさせない）」。Claude（2025年版）は「白紙で始め、過去会話はツール呼び出しで検索」から出発した。その後、要約やトピック単位の記憶を新しい会話に渡す方式を加え、両者が混ざったハイブリッドになっている。どのシステムも、常時注入する部分を小さく抑え、ユーザーが見て編集できる形にしている。

### Cited Findings
- MemGPT（2023-10-12 初版、2024-02-12 v2）は OS の階層メモリにならった "virtual context management" を提案した。速いメモリと遅いメモリの間でデータを移し、interrupt で制御を管理する。評価は文書分析と multi-session chat。 — [arXiv 2310.08560](https://arxiv.org/abs/2310.08560)
  - 未検証（本文は未確認、調査者の既知知識）: main context は system instructions、working context、FIFO queue の三つ。external context は recall storage（会話履歴）と archival storage の二つ。どちらも関数呼び出しで出し入れする。
- Letta の memory blocks は "structured sections of the agent's context window that persist across all interactions" で、常に context 内にある。各ブロックは `label`、`description`、`value`、`limit`（文字数上限）を持つ。標準は `human`（ユーザー）と `persona` の2ブロック。`read_only` を指定でき、複数 agent で共有もできる。外部から `value` を書くと全置換で、同時書き込みは last-write-wins。 — [Letta docs: Memory blocks](https://docs.letta.com/guides/agents/memory-blocks)
- Letta がブロックに向くとする情報: ツール使用上の注意、作業メモ（scratchpad）、外部状態の写し（ユーザーが今開いている文書など）、共有ポリシー、subagent 結果などの調整状態。 — [Letta docs: Memory blocks](https://docs.letta.com/guides/agents/memory-blocks)
- Letta の archival memory は context に pin できない。`archival_memory_insert` と `archival_memory_search`（semantic 検索、tag で絞り込み可）で on-demand に取得し、容量は事実上無制限。向く内容は参照資料、研究メモ、過去の出来事の記録。逆に「常に見えるべき情報」や「頻繁に変わり編集される情報」はブロックに置く。過去メッセージの検索（recall）は archival と別系統。 — [Letta docs: Archival memory](https://docs.letta.com/guides/agents/archival-memory)
- ChatGPT memory は二層。"Saved memories"（明示的に保存したもの、またはモデルが保存したもの）と "Reference chat history"（過去会話から得た情報で、ChatGPT の判断で更新され変化する）。FAQ の表現は "ChatGPT decides which available information is relevant to a response"。chat history 側に別枠の容量上限はない。新方式は "continually updated synthesis" で、旧方式（legacy）は個別項目のリスト。 — [OpenAI Help: Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)、[OpenAI Help: Reference saved memories](https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work)
- 未検証（二次資料、2025年時点の reverse engineering）: ChatGPT は前の会話の詳細を毎回の会話の冒頭に自動で入れる。モデルが取得するかどうかを決める仕組みではない。過去会話から取り出すのはユーザー発言だけで、assistant の応答は含めない。 — [Simon Willison 2025-09-12](https://simonwillison.net/2025/Sep/12/claude-memory/)
- 未検証（二次資料経由、単一ソース）: プロファイルの大きさは Claude 約1,000 tokens、ChatGPT 約4,000 tokens。ChatGPT の注入は "six distinct layers"。 — [Gigazine 2025-09-16](https://gigazine.net/gsc_news/en/20250916-chatgpt-claude-memory-different)、[Simon Willison tag llm-memory](https://simonwillison.net/tags/llm-memory/)
- Claude（2025-09 時点）は白紙で始まり、`conversation_search` と `recent_chats` の2ツールで過去会話の原文を検索した。Willison は「tool call として見えるので、いつ何を参照したか分かる」点を評価している。 — [Simon Willison 2025-09-12](https://simonwillison.net/2025/Sep/12/claude-memory/)
- Claude の公式ヘルプ（2026-11 時点）:
  - 過去チャット検索は RAG で、"appear as tool calls"。
  - 旧方式の memory summary は24時間ごとに作り直し、"provides context for every new standalone conversation"。
  - 新方式は "saves individual topics as you chat"。
  - project ごとに memory を分け、incognito は検索対象外。
  - Team/Enterprise は 2026-10-31 以降に作られた組織で既定オン。

  — [Claude Help Center 11817273](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context.md)
- Anthropic の context engineering 指針（2025-09-29）: "just in time" 方式では、識別子（パスやクエリ）だけを context に持ち、本体は実行時にツールで読む。Claude Code はハイブリッドで、CLAUDE.md は最初から注入し、それ以外は glob/grep で取得する。永続ストレージへの structured note-taking と compaction も推奨している。compaction prompt は「まず recall を最大化し、次に precision を上げる」順で調整する。 — [Anthropic Engineering: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

### Inferences
- 実務で収束している形は「小さく上限付きで、ユーザーが編集できる常時ブロック（プロファイルと作業状態）＋大容量の保管庫（ツール検索、または自動 RAG）」。Letta はこれを文字数上限で、ChatGPT と Claude は要約の再合成で実現している。
- ChatGPT が取得判断をモデルに任せない理由は推測になる（未検証）。消費者向けの「何も言わなくても覚えている」体験では、ツールを呼ばないこと（under-retrieval、A3参照）の害が大きいと判断した可能性がある。

### Gaps
- ChatGPT の現行の注入トークン量と層構成について、公式情報は見つからなかった。数値は2025年の reverse engineering だけ。
- Claude の新方式（topic 単位）で、何が毎ターン注入されるのかは公式ヘルプに書かれていない。

## (A2) 長い context での性能劣化（Lost in the Middle、context rot、NoLiMa、RULER）は、注入量について何を示すか

### Takeaway
公称の context 長は「実際に使える長さ」ではない。32K 程度で既に大きく劣化するモデルが多い。劣化は、語彙の重なりが小さい情報、似ているが誤った distractor、中間位置の情報で特に強い。したがって常時注入は「小さく、関連度が高く、矛盾しない」ものに限り、重要な情報は先頭か末尾に置くのがよい。

### Cited Findings
- Lost in the Middle（Liu ほか、2023-07-06、TACL）: 性能は U 字型になる。関連情報が入力の先頭か末尾にあると最も高く、中間にあると大きく下がる。課題は multi-document QA と key-value retrieval。この傾向は "even for explicitly long-context models" でも見られた。 — [arXiv 2307.03172](https://arxiv.org/abs/2307.03172)
- RULER（2024-04、COLM 2024）: 17 モデルはすべて 32K 以上を公称するが、"only half of them can maintain satisfactory performance at the length of 32K"。 — [arXiv 2404.06654](https://arxiv.org/abs/2404.06654)
- NoLiMa（2025-02-07、ICML 2025）: 質問と needle の語彙の重なりを最小にした needle-in-a-haystack。128K 以上を公称する 13 モデルのうち 11 モデルが、32K で短い context での成績の 50% を下回った。GPT-4o でも 99.3% から 69.7% に落ちた。 — [arXiv 2502.05167](https://arxiv.org/abs/2502.05167)
- Chroma "Context Rot"（2025-07、Hong、Troynikov、Huber）: GPT-4.1、Claude 4、Gemini 2.5、Qwen3 など 18 モデルで、入力が長くなるほど信頼性が下がることを示した。意味が近いが誤った distractor や、context の構造が劣化を強める。NIAH は語彙一致の検索しか測らないとも批判している。 — [Chroma Research](https://research.trychroma.com/context-rot)、[GitHub](https://github.com/chroma-core/context-rot)
  - 利害関係の注意: Chroma は vector DB の会社なので、RAG に有利な結論になりやすい。 — [The Decoder](https://the-decoder.com/yet-another-study-finds-that-overloading-llms-with-information-leads-to-worse-results/)
- Anthropic: context rot は全モデルで起きる段階的な劣化で、急な崖ではない。context は "attention budget" として扱うべきとしている。 — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- MERIT（2026-07-26）: 23,440 episode のコスト付き評価。全履歴の再投入（full replay）が最も経済的になることは一度もなかった。各 domain で最良の方式は、1ドルあたりの限界効用が 2.7〜3.9 倍だった。記憶の実装を差し替えるだけでタスク成功率が最大 60 ポイント変わった。 — [arXiv 2609.05441](https://arxiv.org/abs/2609.05441)

### Inferences
- 音声の常駐エージェントでは会話履歴が際限なく伸びる。そのため「全履歴を入れる」方式は品質の面でもコストの面でも不利と考えられる（RULER、NoLiMa、MERIT から推論）。
- 常時注入するプロファイルの中で、意味の近い古い事実と新しい事実が並ぶと distractor になりうる（Chroma の結果から推論）。上書き更新（update-on-write）で矛盾を残さない方がよい。MERIT は、更新型の fact store が 0.70〜1.00、embedding 検索が 0.30〜0.95 と報告している（A3 参照）。

### Gaps
- 「数百〜数千 tokens のプロファイルブロックを足すと、短い context の対話品質が下がるか」を直接測った研究は見つからなかった。ここまでの劣化研究は主に 8K〜128K 帯。

## (A3) モデルは必要な時に記憶検索ツールを呼ぶか（under-retrieval）、およびツール往復のコストと音声での遅延

### Takeaway
「必要な時に自分で取りに行く」ことの直接評価はまだ少ない。それでも、取得しても使わない（ignore）、明示的に聞かれないと記憶を使わない、という失敗が繰り返し報告されている。音声では、ツール1往復ごとに LLM 判断 200〜1000ms とツール実行 100〜2000ms が上乗せされる。そのため、必須の記憶は事前に注入し、ツールは補助と割り切るのが合理的。

### Cited Findings
- MERIT（2026-07）の主な数値 — [arXiv 2609.05441](https://arxiv.org/abs/2609.05441):
  - 記憶があると、依存タスクの成功率は 0.00 から 0.55〜1.00 に上がる。
  - 更新された事実については embedding 検索が不安定で、成功率はモデルにより 0.30〜0.95、seed 間の差は最大 0.45。
  - 正しい値を取得できても、それに基づいて行動したのは 55% だけ。
  - update-on-write 型（構造化 fact store、LLM 要約）は 0.70〜1.00。hybrid は fact store 単独より悪かった。
  - 未検証: 検索スニペットには Ignore Rate 0.45〜0.53 という数値があったが、abstract では確認できなかった。
- Mem2ActBench（2026-01-13）: 既存のベンチマークは「明示的な質問への受動的な取得」しか測っていない。そこで、過去の好みやタスク状態を言い直されなくてもツールの引数に反映できるかを測った。2,029 session と 400 tool-use task を用い、7 つの記憶フレームワークがいずれも "inadequate"。 — [arXiv 2601.19935](https://arxiv.org/abs/2601.19935)
- 記憶の誤りがどこで起きるかについて、二つの報告は結論が食い違う。どちらも未検証（検索スニペットのみ）。
  - 主に retrieval 段階で起きる。 — [arXiv 2603.02473](https://arxiv.org/html/2603.02473v1)
  - Mem0、A-Mem、LightMem では誤りの 61〜62% が、関連記憶を取得した後に起きる。 — [arXiv 2607.01071](https://arxiv.org/pdf/2607.01071)
- Claude の過去チャット検索は、基本的にユーザーが「前に話したあれ」と頼む形で呼ばれ、tool call として見える。 — [Claude Help](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context.md)、[Simon Willison](https://simonwillison.net/2025/Sep/12/claude-memory/)
- 音声パイプラインの遅延内訳（Stream、2025-12-23）:
  - ASR 約300ms、ツール呼び出しを決める LLM 判断 200〜1000ms、ツール実行 100〜2000ms、結果を処理する LLM 約300ms、TTS 250〜300ms。
  - 対策として、filler 発話（1.5〜2 秒を稼げる、filler 生成は 20〜50 tokens 分の遅延）、speech-first prompting、読み取り専用ツールの speculative/eager 実行、使わなかった推測呼び出しの取り消しを挙げている。

  — [GetStream: Speculative tool calling](https://getstream.io/blog/speculative-tool-calling-voice/)
- Deepgram: 注文状況の照会は filler 込みで「2 round trip、3 function call」になる。関数応答が返らないと agent が無限に待つので timeout が必要。 — [Deepgram blog](https://deepgram.com/learn/voice-agent-function-calling-real-time-data-lookup)
- ツールを使わない通常ターンの目安は 600〜1,200ms（利用者側で計測）。独立テストでは平均 1,740ms の例もある。どちらもベンダー記事なので参考値。 — [Twilio](https://www.twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents)、[Telnyx](https://telnyx.com/resources/voice-ai-delay-causes.md)
- Zep/Graphiti（2025-01-20）: DMR 94.8%（MemGPT は 93.4%）、LongMemEval で最大 +18.5%、"baseline implementations" と比べて応答遅延 −90%。ベースラインが full-context かどうかは abstract からは確認できない。 — [arXiv 2501.13956](https://arxiv.org/abs/2501.13956)

### Inferences
- 音声で検索ツールを1回挟むと、応答は少なくとも数百ms、最悪で数秒遅れる。毎ターン必要になる情報（呼び名、話し方の好み、進行中の予定や計画）は事前注入の方が遅延面で有利と推論する。
- 「ツールを呼ばない」「取得しても使わない」の両方が起きる。このため、記憶をツールだけに任せる設計は能動的な利用（ユーザーが言わなくても使う）に弱い（Mem2ActBench、MERIT から）。
- 遅延を避ける中間案として、自前のパイプライン（LLM の判断ではない）が発話ごとに軽い検索をかけ、上位数件を末尾に差し込む auto-RAG がある。これは ChatGPT の chat-history 参照に近い。

### Gaps
- 「記憶検索ツールの呼び出し率（呼ぶべき場面のうち何%で呼んだか）」を直接測った査読済みの研究は見つからなかった。
- 音声エージェントで記憶検索ツールが遅延に与える影響を測った学術研究は見つからなかった。数値はベンダー blog のみ。

## (A4) Prompt caching が注入位置に与える制約

### Takeaway
OpenAI も Anthropic も、完全一致した prefix をキャッシュする。安定した内容（ツール定義、システム指示、常時プロファイル）を先頭に置き、変わりやすい状態（時刻、直近の検索結果、当日の予定）は末尾に置くのが公式の推奨。変わりやすい値を system の先頭近くに入れると、毎回キャッシュが外れる。

### Cited Findings
- Anthropic の基本仕様 — [Claude Docs: Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
  - prefix は `tools` → `system` → `messages` の順で作られる。ある層を変えると、その層と後ろの層がすべて無効になる。ツール定義の変更は全層を無効にする。
  - 1文字違うだけで別の hash になる。
  - 料金は 5 分 TTL の書き込みが 1.25 倍、1 時間 TTL が 2 倍、読み込みは既定 0.1 倍（Opus 5.5 / Sonnet 5.5 は 0.05 倍）。
  - 最小キャッシュ長は 512〜4,096 tokens で、モデルにより異なる。lookback は 20 block。
- Anthropic のよくある失敗例: per-request の timestamp とユーザー発言を含むブロックに breakpoint を置くと "no cache hit" になり、書き込み料金だけ払い続ける。1 時間キャッシュは "latency is important and your follow-up prompts might be sent beyond 5 minutes" の場合に有用。`max_tokens: 0` で pre-warm すると初回の TTFT を下げられる。 — [Claude Docs: Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- OpenAI の仕様 — [OpenAI: Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching):
  - "Cache reuse requires the entire rendered prefix to match"。
  - 安定した内容（developer instructions、tool definitions、共有の参照資料）を先頭に置き、timestamp やユーザー固有の情報は末尾か後の message に置く。
  - 次の変更でキャッシュは無効になる: ツールの名前・説明・schema・順序、`reasoning.effort`、compaction・要約・切り詰め。
  - GPT-5.6 以降は TTL が 30 分（書き込み 1.25 倍）または 12 時間（2.5 倍）、読み込みは 0.1 倍。`prompt_cache_key` は routing に影響するが、hit を保証しない。

### Inferences
- 常時注入する記憶は、更新頻度で並べ分けるのがよい。
  1. 固定指示とツール（最も安定）
  2. 長期プロファイル（日単位で更新）
  3. 会話履歴
  4. 揮発状態（時刻、当日の計画、直近の検索結果）は最後のユーザー発言の直前
- プロファイルを毎ターン書き換えると、後ろにある会話履歴のキャッシュまで毎回外れる。プロファイルの更新は、会話の区切りや一定時間ごとにまとめて反映するのがよい（Claude の 24 時間再合成も同じ形）。
- 常駐の音声会話は発話の間隔が不規則で、5 分 TTL を超えやすい。1 時間 TTL や pre-warm を検討する余地がある。
- Lost in the Middle の結果と合わせると、末尾の揮発状態は注意も向きやすい位置にある。先頭のプロファイルも U 字の高い側に入る。

### Gaps
- ローカル推論（llama.cpp や vLLM の prefix cache）でも同じ制約が成り立つと推測するが、今回は資料を確認していない。

## (B1) 能動型・混合主導（mixed-initiative）エージェントのユーザーモデルと計画・目標の扱い

### Takeaway
能動型の対話研究は、もともと対話の主導権（clarification、目標誘導、非協調）を扱ってきた。LLM 時代になって「環境やユーザーの行動から次のニーズを予測する」方向に広がった。ただし、ユーザーモデルの保持方式（静的な特性と動的な好みの分離、時間変化の追跡）は、まだ弱点として測られている段階にある。

### Cited Findings
- 能動型対話システムのサーベイ（Deng ほか、IJCAI 2023 survey track）: clarification、target-guided、non-collaborative などの対話類型ごとに問題を整理した。LLM 専用のサーベイではない。 — [arXiv 2305.02750](https://arxiv.org/abs/2305.02750)
- "Towards Human-centered Proactive Conversational Agents"（SIGIR 2024 perspectives）: intelligence、adaptivity、civility の3軸で分類した。 — [arXiv 2404.12670](https://arxiv.org/pdf/2404.12670)
- LLM の proactive dialogue 評価（2023）: clarification、目標誘導、非協調対話でプロンプトを評価した。 — [arXiv 2305.13626](https://arxiv.org/pdf/2305.13626)
- Proactive Agent / ProactiveBench（Lu ほか、2024-10-16、v3 2024-12-03）:
  - 実際の人間の活動から作った 6,790 件のイベントで、agent が支援を申し出るか予測するタスク。
  - 人間の accept/reject ラベルで reward model を学習し、自動評価器にした。
  - fine-tune したモデルの F1 は 66.47%。

  — [arXiv 2410.12361](https://arxiv.org/abs/2410.12361)
- ProPerSim / ProPerAssistant（2025-09）: LLM が演じるユーザーがいる模擬家庭環境で、提案のタイミングと内容を feedback から学ぶ。retrieval-augmented で、好みに合わせる。「いつ割り込まれたいか」「どんな能動的内容が有用か」はユーザーごとに違うと指摘している。 — [arXiv 2509.21730](https://arxiv.org/html/2509.21730v1)
- 未検証（スニペットのみ）: 1,000 persona の模擬データで学習し、端末上で個人向けに軽く steering する preference-aligned proactive assistant（2026-02）。 — [arXiv 2602.04000](https://arxiv.org/html/2602.04000v1)
- MemoryBank（2023-05-17）:
  - 記憶の保存と取得に加え、過去の対話から user portrait（性格の要約）を合成する。
  - Ebbinghaus の忘却曲線に基づき、経過時間と重要度で記憶を忘れたり強化したりする。
  - 実装例は伴走型チャットボット SiliconFriend。
  - 未検証: 保存方式と portrait 生成の詳細は本文を確認していない。

  — [arXiv 2305.10250](https://arxiv.org/abs/2305.10250)
- PersonaMem（"Know Me, Respond to Me"、COLM 2025）:
  - プロファイルは静的特性（demographics）と動的特性（preferences）で構成する。
  - 180 以上の対話履歴、最大 60 session、15 シナリオ。
  - 「最新の好みを認識できるか」「好みの時系列を追えるか」を測る。
  - GPT-4.5 や Gemini-2.0 でも総合正答率は約 50%。

  — [arXiv 2504.14225](https://arxiv.org/abs/2504.14225)、[MSR](https://www.microsoft.com/en-us/research/?p=1149165)
- 未検証（スニペットのみ）: EvoArena の PersonaMem-Evo では、好みが変化する環境で平均正答率 39.6%。 — [arXiv 2606.13681](https://arxiv.org/html/2606.13681)
- Mem2ActBench: 中断を挟む長い会話の後で同じ話題に戻った時、言い直されなくても以前の好みやタスク状態を適用できるかを測る。既存のフレームワークは不十分だった。 — [arXiv 2601.19935](https://arxiv.org/abs/2601.19935)

### Inferences
- 研究上の user model は大きく二つに分かれる。一つは静的特性と動的な好みを持つプロファイル（PersonaMem、MemoryBank の portrait）。もう一つはタスクや目標の状態（Mem2ActBench、ProactiveBench の活動予測）。両方を一つの自由文の要約に混ぜると、時間変化の追跡に失敗しやすい（PersonaMem の約 50% から推論）。

### Gaps
- 研究計画や長期目標の「進捗状態」をユーザーモデルとしてどう保持するかを扱った、LLM 能動エージェント専用の研究は特定できなかった。2024〜2026 年の LLM 能動エージェント専用サーベイも、今回の検索では特定できなかった。

## (B2) いつ話しかけるか（interruptibility / when-to-speak）

### Takeaway
HCI では1999年から「割り込みのコストと先送りのコストの比較」で考えるのが定石になっている。タスクの切れ目（breakpoint）で通知すると割り込みのコストが下がる。LLM 時代の実装は、小さな判定器で発話の可否を決め、大きなモデルで生成する二段構成が増えている。

### Cited Findings
- Attention-Sensitive Alerting（Horvitz、Jacobs、Hovel、UAI 1999）: 通知を先送りするコストと割り込むコストを、状況に応じて比べる。Bayesian モデルで、デスクトップ操作、顔の向き、会話の有無などから注意状態を推定した。 — [MSR](https://www.microsoft.com/en-us/research/publication/attention-sensitive-alerting/)、[erichorvitz.com](https://erichorvitz.com/attend.HTM)
- Iqbal & Horvitz（CHI 2007）: 作業負荷が高い時に割り込むと、元の作業に戻るまでの時間が延びる。 — [PDF](https://www.erichorvitz.com/CHI_2007_Iqbal_Horvitz.pdf)
- Iqbal & Bailey: 行動単位の切れ目（breakpoint）では作業負荷が低く、そこで通知すると割り込みのコストが下がる。コストは breakpoint の粒度で変わる。OASIS で breakpoint に合わせて通知を出すと、苛立ちと反応時間が減った。 — [UIUC thesis](https://ideals.illinois.edu/items/83111)、[MSR: Paying Attention to Interruption](https://www.microsoft.com/en-us/research/?p=183260)
- Bounded deferral（Horvitz）: 通知を一定時間まで先送りする方式。 — [PDF](https://erichorvitz.com/bounded_deferral.pdf)（本文未確認）
- Inner Thoughts（Liu ほか、2024-12-31、v2 2025-02-18）: 会話と並行して内部の思考の流れを持ち、それぞれの思考を表に出したい intrinsic motivation に基づいて、発言するかどうかを決める。24 人の formative study を行った。ユーザー評価では、擬人性、一貫性、知性、ターン取りの適切さでベースラインを有意に上回った。 — [arXiv 2501.00383](https://arxiv.org/abs/2501.00383)
- LlamaPIE（ACL 2025 Findings）: 耳に装着する常時の会話支援。「いつ応答するかを決める小さなモデル」と「応答を生成する大きなモデル」の二段構成。ユーザー知識を使って文脈に沿った支援をする。無支援や reactive 型より強く好まれた。Apple M2 で動作。 — [arXiv 2505.04066](https://arxiv.org/abs/2505.04066)
- "Do Proactive Agents Need an LLM to Decide When to Act?"（2026-05、v2 2026-09） — [arXiv 2605.30152](https://arxiv.org/abs/2605.30152):
  - ユーザーの活動を event と entity の時間グラフとして扱う小さな TGL controller で、トリガーと context の選択を一度の forward pass で決める。
  - 9 方式の中で AUC が最高。下流の 14 backbone で F1 が平均 +16.7。
  - 1 event あたり 11〜14ms、メモリ約 220MiB。
- DiscussLLM（2025-08）は無言 token を出せるように学習する。PRISM（2026-02）は判定閾値付近でだけ遅い熟考を使う。PITCH（2026-10）は多人数チャットで発言タイミングを測るベンチマーク。Jarvis（2026-10）は話し手の言い直しの窓を待ってから発話する。いずれも未検証（スニペットのみ）。 — [2508.18167](https://arxiv.org/pdf/2508.18167)、[2602.01532](https://arxiv.org/html/2602.01532v1)、[2610.25896](https://arxiv.org/pdf/2610.25896)、[2610.07506](https://arxiv.org/pdf/2610.07506)

### Inferences
- 待機中も LLM で毎回「話すべきか」を判定するとコストがかかる（2605.30152 の問題提起）。軽い判定器と大きな生成モデルを分ける構成が、2025〜2026 年の主流になりつつある。
- 判定器が参照する user model の項目は、「今は話しかけてよいか」（作業中、在室、静かにしたい時間帯）と「話す価値がある話題か」（未解決の計画、関心）に分けられる。前者は揮発状態、後者は長期プロファイルにあたる。

### Gaps
- 音声の常駐アシスタントが自発的に話しかけることへの受容度を長期の実地調査で測った研究は、今回は特定できなかった。

## (B3) ユーザーについて学ぶための質問と、既知情報の再質問の回避

### Takeaway
受動的な記憶（ユーザーが自分から言ったことを覚える）だけでは、言われなかった好みは決して得られない。2026 年の研究は、「後で役立つ好みを今聞く」ことを費用対効果で選べば、少ない質問で多くの効用を回収できると示した。再質問の回避を直接測った研究は見つからなかった。

### Cited Findings
- "Ask Now, Use Later"（EMNLP 2026 Main、2026-05-27、v3 2026-09-15）:
  - 長く使われる agent は、ユーザーが自分から言った好みしか持たない。"an agent cannot act on a preference it never obtained"。
  - Ask-to-Remember（ATR）を定義した。今のタスクには不要だが、同じユーザーの将来の session で必要になる好みを今聞くかどうかの判断。
  - frontier LLM agent 8 種の既定設定は、好みを与えた oracle より 62 ポイント以上低かった。プロンプトの工夫では差はほとんど縮まらない。主な制約は「好みの獲得」そのもの。

  — [arXiv 2605.28108](https://arxiv.org/abs/2605.28108)
- Active Preference Acquisition（2026-10-22、v2 2026-10-25）:
  - 好みの候補ごとに Prospective Personalization Value を計算する。将来のタスクで得られる効用の合計から、質問の手間と開示リスクを引いた値。
  - 1 回のやり取りごとの質問予算の中で、何を聞くかを選ぶ。
  - 「知らない好みを全部聞く」は「何も聞かない」より正味の効用が低い。
  - APA は質問の 27.6% で効用改善の 84.2% を回収した。
  - 将来の再利用で価値が出る好みの 80.3% を獲得した。現在タスクの情報価値（VoI）で選ぶ方式は 5.1%。

  — [arXiv 2610.31107](https://arxiv.org/abs/2610.31107)
- 未検証（スニペットのみ）: profile customization で cold-start に対処する研究（2025-12）。 — [arXiv 2512.15302](https://arxiv.org/abs/2512.15302v1)
- Prompting and Evaluating LLMs for Proactive Dialogues（2023）: 曖昧な時に確認質問をするかどうかを評価した。 — [arXiv 2305.13626](https://arxiv.org/pdf/2305.13626)

### Inferences
- 再質問を避ける最低条件は、質問する前に「その属性が既にプロファイルにあるか」を確かめられること。具体的には二通りある。
  - 属性が常時注入されている。
  - 質問を生成する前に必ずプロファイルを参照する仕組みになっている。

  ツールでの検索だけに任せると、under-retrieval（A3）がそのまま再質問になる、と推論する。
- 「何を聞くか」は、将来の再利用価値と質問の手間の比較で選ぶ（APA）。質問の数に予算を設け、「何を聞いたか」「答えを保留されたか」も記録すれば、同じ質問を繰り返す失敗を防げる（推論）。

### Gaps
- 既知情報を再質問する頻度を直接測ったベンチマークは見つからなかった。ATRBench も APA も再質問は扱っていない。

## (B4) 構造化した長期プロファイルと、期限付きの一時的な計画・意図の分離

### Takeaway
主要なシステムと研究は、少なくとも「安定した特性・好み」と「変化する状態・出来事」を別の層で持つ。変化する情報は、上書き更新、時刻と有効期間、忘却・減衰のいずれかで扱う。追記だけの embedding 保管庫は、古い値と新しい値が混ざって不安定になる。

### Cited Findings
- ChatGPT は saved memories（明示的、ユーザーが削除するまで残る）と chat history 由来の情報（ChatGPT が更新し、変化する）を分けている。後者をオフにすると、得た情報は 30 日以内に削除予定になる。 — [OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)
- Letta はブロックで分ける。`human` と `persona` は安定した情報、scratchpad ブロックは現在の作業メモ、archival は過去の出来事の記録。 — [Letta docs: Archival memory](https://docs.letta.com/guides/agents/archival-memory)、[Letta docs: Memory blocks](https://docs.letta.com/guides/agents/memory-blocks)
- PersonaMem は、静的特性（demographics）と動的特性（preferences）を分けて評価し、「最新の好み」と「好みの時系列」を別の能力として測る。 — [arXiv 2504.14225](https://arxiv.org/abs/2504.14225)
- MemoryBank は、経過時間と重要度に基づく忘却曲線で記憶を減衰・強化する。 — [arXiv 2305.10250](https://arxiv.org/abs/2305.10250)
- MERIT は、更新された事実について update-on-write 型の store（0.70〜1.00）が embedding 検索（0.30〜0.95）より安定と報告している。 — [arXiv 2609.05441](https://arxiv.org/abs/2609.05441)
- Zep/Graphiti は時間を扱う knowledge graph で、履歴上の関係を保持する。 — [arXiv 2501.13956](https://arxiv.org/abs/2501.13956)
  - 未検証（調査者の既知知識、abstract には記載なし）: edge ごとに有効期間（valid/invalid）を持つ bi-temporal モデルで、矛盾する新しい事実が来ると古い edge を無効にする。
- Claude は project ごとに memory を分け、project memory はその project の中でだけ使う。 — [Claude Help](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context.md)

### Inferences
- 3層に分けると整理しやすい。
  1. 長期プロファイル: 呼び名、関心、話し方の好み。上書き更新し、常時注入し、cache prefix に入れる。
  2. 進行中の計画・目標: 期限、状態、最後に触れた日時を持つ構造化レコード。件数を絞って常時注入するか、末尾に注入する。
  3. 出来事・会話の記録: 検索用で、期限なし。
- 2層目は期限が来たら、自動で消すのではなく「確認待ち」に移し、能動的な話題の候補（B2）や質問の候補（B3）に回すと、能動型の設計につながる（推論）。

### Gaps
- 期限付きの意図（intention with expiry）を明示したスキーマを公開している主要製品は見つからなかった。ChatGPT Tasks のような予定機能と記憶の関係も今回は調べていない。
