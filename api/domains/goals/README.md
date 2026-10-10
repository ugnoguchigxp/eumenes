# Goals

Goalの明示採用、提案、改訂、完了、取下げを管理する。提案は明示的に採用するまでadopted snapshotに含めない。現在のserverに自動提案writerは接続されていない。

`operationKey`はprincipal/scopeごとの操作再送ID。同じkeyと同じ入力なら保存済みGoalを返し、入力が異なれば`operation_conflict`になる。文面、priority、sourceの版も入力digestに含む。文面の大小文字、Unicode幅、空白を理由に別操作を統合しない。

keyは任意。keyなし、または別keyの入力は、文面が同じでも独立した操作として保存する。繰り返し処理のcallerは安定した操作IDを渡す。自由文の正規化から再送IDを作らない。提案50件、採用30件の既存上限、scope権限、revisionとepochの検証は維持する。
