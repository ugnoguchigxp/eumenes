# 無操作先読みで増える匿名メイン接続の修正

2026-11-01。利用者の「同じ会話のメイン接続を再利用し、放置しても接続が増えず、200k／128kの分離と音声連携が維持されることを確認」に基づく。既存の[接続設計](larm-agent-capacity-design-2026-11-01.md)を満たす不具合修正であり、役割・容量・Profile選択・LLMの判断方式は変えない。

## 根拠

稼働APIでconversationId=nullのmain200000を3本、旧共有LLM131072を1本確認。生成中0件でもLARMのruntime Allocation上限4を占めていた。08:44:01 JSTの4回目の自然な先読みはruntime_capacityで待機し、Eumenes側の60秒で終了、08:45のAPI状態がfailedに変わった。他3本はreadyのまま。prewarm・agency・stewardのonConversation呼出しでagentSessionを渡さず、inferenceがrequest IDをagent IDに代入するためである。保持・renew自体は正常だった。

LARMのGET接続はsemantic readinessの短期cacheが切れるとready+claimable=falseになる。現awaitReadyはGETだけを繰り返し、cacheを再確認する操作がなく止まることも調査用試験で再現した。既存のProvider health APIがsemantic checkを行う。正常なclaim・容量検証を省略する解決にはしない。

## 修正する範囲

1. prewarm・agency・stewardから、管理情報にある会話IDと同じメインagent IDをCallSession.agentSessionへ渡す。本文やID文字列から会話を復元しない。inference/LARM境界では、会話メインとonConversationに所有者がなければ確保前に拒否し、独立補助にだけ既存のrequest/task IDを使う。
2. createAgentLarmの共有portは非LLM用とする。LLMのconnect/probeは選択済みの論理agentを使い、未選択の初期probeは既存catalogの読み取りだけで接続を作らない。音声等のscopeはcatalogにある非LLM Provider群をすべて維持し、LLMの余分なAllocationだけを要求しない。音声・態度判定の既存claim/renew/保持経路は再利用する。
3. 独立auxiliaryの一回限りの接続は呼出し完了後に解放する。subagentは既存releaseTaskSession操作に接続解放を接続し、使用中の処理は自然終了を待つ。同じ有効task接続は終了まで再利用する。メインの保持と同じclient/cache keyの規則は維持する。
4. ready+claimable=falseの初回取得/再取得は、既存Provider healthで対象の準備を再確認した後、GETのclaimableと容量を照合してclaimする。既存の準備期限・取消は維持し、生成POSTの再送、サブから200kへの昇格、独自生成項目は追加しない。

LARMの設定・上限やサーバー稼働状態、公開UI、音声の再生経路、製品DBは変更しない。新しい判断方式・優先順位・フォールバックは導入しない。重複排除は意味判断ではなく明示された管理IDの一致で行う。

## 作業と完了条件

- baseline: 先の調査では既存19件と調査用4件が成功し、後者は不具合の現挙動を再現している。今回の変更前に入口と容量の対象試験を採取する。
- 部分: 全onConversation入口が同じ会話所有者を渡す。欠落は接続POST前に拒否。メイン/背景を繰り返しても1本で、20分の無操作・非表示通知・renew後も同じID。独立補助の完了とtask終了は正しい接続だけ解放する。
- 結合: 実inference/自動prewarmを接続し、初期probe・3回以上の先読み・会話の継続で200k1本を再利用。別会話・別agent・分岐は分離。subは指定省略131072、1+2枠と取消、未知の生成結果を再送しないことを維持。ASR/TTS/英語TTS/態度判定は非LLM scopeで通る。
- domain verify: larm、inference、dialogue、steward、agency、voice-dialogueと影響する利用側を選択し、部分→結合→通しの順に実行。範囲外の失敗は勝手に直さず記録する。UI変更がないためブラウザーE2Eを省略し、既存Web試験は実行する。
- live: 保存設定の読み取り専用操作から隔離clientで確認する。稼働中の旧backendは匿名接続を保持しており、新接続を試す空きがない場合は阻害要因として分離する。稼働反映・旧匿名接続の整理が必要なときも、backendの停止・起動・再起動は明示許可を得るまで行わない。
- 最後に担当外の差分も含めて点検し、本文依存の分岐・Profile/モデルの固定・credential/本文の診断出力がないことを確認。fixture、live、稼働反映、実機器受入を区別する。

## 実装・検証結果

接続再利用・音声scope分離・寿命の解放・claimableの再確認を実装。関連7domainのverifyはbackend1,741件・Web95件成功。正確に20分進める時計へ試験を整理した後の追加対象48件も成功。実LARMではLLMなしの音声scopeでASR/TTSが成功し、200k作成要求を確認したが、新メイン生成は既存接続のある環境でpendingとなった。稼働反映はサーバー操作の明示許可待ち。[受入記録](verification/larm-main-reuse-2026-11-01/acceptance.md)に成功範囲・残作業を分けて記録した。
