# 音声 MVP 受入記録

2026-10-07、macOS 26.6.2、Bun 1.4.2、Playwright 1.61.1 Chromium。Playwright の合成マイクと LARM fixture で、音声開始、ASR 確定、履歴に基づく回答、TTS 再生、再生中の次発話、二重発話 ID の抑止を確認。実 LARM は SAAA の保存済み接続先を読み取り専用で確認し、ローカルで生成した合成日本語 WAV を使った ASR・LLM・TTS の個別操作が成功。ASR 文字列には期待語「こんにちは」が含まれた。ASR 1268ms、LLM 8209ms、TTS 3757ms（この1回の測定値）。実マイク、ヘッドホン、実 ASR・LLM・TTS とブラウザをつないだ3往復は未受入。

| 条件 | 状態 |
| --- | --- |
| 画面から3往復し、前の発話を踏まえた回答を実機器で聞く | 未受入 |
| 再生中に発話して前の再生を止める | fixture で確認、実機器は未受入 |
| 同一発話 ID・request ID の重複抑止 | backend fixture で確認 |
| 音声 stream の上限と順序 | 4 MB 超過を ASR 前に拒否し、sequence の飛び番と同一発話 ID の異なる sequence を拒否する試験を確認 |
| ASR・LLM・TTS・再生の失敗表示 | 部分確認、故障箇所ごとの画面受入は未完了 |
| 録音 start/stop 3回と遅延 callback 抑止 | Web 単体試験で確認 |
| DB 再起動、未確定 run 復旧、writer 排他 | SQLite 試験で確認 |
| CLI と Web の同一履歴 | browser fixture 内で実 CLI の送信、同一 request ID の再送、履歴取得、画面反映を確認。中断・接続不能は未試験 |

次の最小工程は、Chrome と実マイク・ヘッドホンで3往復を操作して各 turn/run を記録し、再生中割込みと失敗表示を確認することです。実機器の型番・権限条件・段階別待ち時間をその際に追記します。
