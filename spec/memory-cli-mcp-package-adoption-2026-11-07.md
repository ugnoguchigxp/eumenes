# Memory配布物の置換とCLI・MCP連携確認

## 目的と範囲

本人の依頼により、`eumenes_memory`のコミット`13f6f47f02203cd392c1c9fbc994e068ea81343d`（sourceHash `0b0f9e5557b7d3ce2fb6fd2acce87dab0186dfd2988808f32d80f986dfffd95f`）から作った本体0.0.4とホスト0.1.0をvendorへ取り込み、Eumenesの依存先とlockfileを更新して再インストールする。版番号だけでは旧0.0.4と区別できないため、配布物のsha256をファイル名とmanifestに記録する。

既存のMemoryService.sharedHost、単一Writer、journal、出典resolver、forget purgeを再利用する。意味の指示や選択方式、DB schema、認証方式は変更しない。既存の別作業の差分を保持する。稼働中のAPI/Webの開始・停止・再起動、既存のチャット設定へのMCP自動登録、個人DBや秘密のコピーは行わない。

## 完了条件と検証順

1. 配布manifest・package.json・lockfile・installed filesのhashが一致し、本体とホスト内のcore runtimeも一致する。
2. 本体とホストを再インストールし、インストール先のCLIを実行できる。
3. 実インストール済みのホストだけを使い、使い捨ての実Eumenes MemoryServiceの同じWriterとjournalへ接続する。アプリ保存をCLI/MCPから取得し、CLI保存をアプリと2つの独立MCPから読み、訂正・忘却・再送・片方の切断後の再接続を確認する。Eumenes CLIのmemory list/statusも同じ検証用APIで確認する。
4. 出典の訂正による旧snapshotの失効、忘却した本文を含む計画の消去、アプリ側のforget fenceと出典ブロックも確認する。試験終了後は使い捨ての接続とDBだけを片付ける。
5. 部分試験→結合試験→標準の`verify --domain memory --domain steward --domain dialogue --domain world`へ進み、結果を`verification-reports/memory-package-adoption-2026-11-07`へ記録する。試験や期待値を弱めず、fixtureの成功と稼働中環境への反映を区別する。

## 更新前の基準

旧依存は`eumenes-memory-0.0.4-9c0e85aa2fa3.tgz`。実ファイルを明示したvendor照合2件とMemory・packaged curation145件は成功した。標準verifyは更新前から`artifacts/pursuit-integration-20261106`内の過去のコピーを試験一覧に拾って停止する。同じ問題を再試行せず、既存成果物を保持したまま、固定した現ソースから生成物を除いた検証用環境で標準ゲートも実行する。実インストール先での結合試験はこれと別に行う。

## 記録

最終の配布物・導入先・試験数・制約は`spec/verification/memory-package-adoption-2026-11-07/summary.json`を正本とする。稼働中のAPIが既に読み込んだ旧モジュールを、この再インストールだけで更新済みとは扱わない。
