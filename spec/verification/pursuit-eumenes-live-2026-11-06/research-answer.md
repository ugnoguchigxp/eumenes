## 比較

| 論点 | WAL | rollback journal |
|---|---|---|
| 複数の書込み | 同時には不可。一度に書込みできるのは1つのwriterです。 | 同時には不可。RESERVEDロックは同時に1つで、データベースファイルへの書込みにはEXCLUSIVEロックが必要です。 |
| 読取り中の書込み | readerとwriterは同時進行できます。readerはtransaction中、固定されたend markまでの内容を読みます。 | writerはRESERVEDロックの段階では既存readerと共存できます。ただしDBファイルへの書込みにはEXCLUSIVEロックが必要で、SHARED readerが残っている間は取得できません。DBファイルへの書込みを始めた後はcommitまでEXCLUSIVEロックを保持し、他プロセスはアクセスできません。 |
| checkpointの停滞 | checkpointはreaderと並行できますが、現行readerのいずれかのend markより先のWALページに達すると停止します。checkpointは進捗位置を記憶し、次回はそこから再開します。長時間のread transactionは進行を妨げえます。 | WAL checkpointに相当する処理は、指定されたrollback-modeの説明では扱われていません。条件は不明です。 |

## 条件と限界

WALではreaderがいる間もwriterはWALへ追記できますが、同時に動けるwriterは1つです。readerのend markはcheckpoint可能な範囲を制限します。rollback journalでは、writerがRESERVEDロックを持つ段階なら既存readerは読取りを続けられますが、DBファイルへの書込みにはreaderがSHAREDロックを解放してからEXCLUSIVEロックを得る必要があります。

指定された本文で確認できたWALのcheckpoint停滞条件は、checkpointが現行readerのend markより先へ進めないことです。本文に記載されていない他の停止・失敗条件やrollback journalでのcheckpoint条件は不明です。

出典：[SQLite Write-Ahead Logging](https://sqlite.org/wal.html)（reader/writerの並行性、checkpoint、§2.2）、[File Locking And Concurrency In SQLite Version 3](https://sqlite.org/lockingv3.html)（rollback-modeのロック状態と書込み手順）。
