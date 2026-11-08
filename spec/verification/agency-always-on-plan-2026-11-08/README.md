# always-on 取り込み計画の追加調査

実施日: 2026-11-08。対象は取り込み元の作業ツリー `always-on-25`。計画書のAO-N1〜N4を確認するため、公開APIをscripted LLMで直接呼び出した。Eumenes製品の受入試験ではない。

## 結果

| ID | 手順 | 観測した不足 |
| --- | --- | --- |
| AO-N1 | 発話票発行→入力をforget→成功receipt | 忘れた入力に依存する観測が1件作成され、unansweredが1増える |
| AO-N2 | 入力を読んでthought作成→独立した21観測→前thoughtを読むtick→元入力をforget | 前thoughtの依存元が2回目の入力sourcesに含まれず、2回目の依存thoughtが残る |
| AO-N3 | 準備依頼→受付成功→tickせず6時間と1ミリ秒後に結果返却 | 期限後の観測・findingが作られる |
| AO-N4 | Aの依頼→Bの発言→Aの準備をrequestPrepare | 票はBに紐づき、提示された能力のinput.sourcesも票へ継承されない。元run/messageを指定するAPIがない |

AO-N1〜N3は境界不具合の再現。AO-N4は呼出元を表す契約の不足であり、実際の通常応答が必ず取り違えるという意味ではない。ホストの世代・run検証で防止する接続が必要になる。

結果は[results.json](results.json)、再現手順は[contract-probes.mjs](contract-probes.mjs)。スクリプトは今回の不足を観測できたことをassertするため終了コード0だが、製品契約の合格を示さない。修正後は期待を反転した回帰試験を所有するリポジトリへ追加する。既存probeのassertを緩めて受入としない。

## 再現

Eumenesルートから、ローカルの取り込み元を指定する。依存が既に導入されていることが前提。検証のためのinstall・pack・サーバー起動は行わない。

```sh
bun spec/verification/agency-always-on-plan-2026-11-08/contract-probes.mjs /absolute/path/to/eumenes_agency
```

入力は検証用の固定文字列だけ。provider・ネットワーク・製品DB・設定・秘密は使っていない。ソース5ファイルのhashを開始時と終了時に比較し、結果に記録した。取り込み元のdirty HEADだけでは同じ実装を特定できないため、追試ではこのhashも照合する。

調査時HEAD: `c632b5632390a8051a30fc1669f3e113087fdfc4`（dirty）。意味判断の品質、実LARMの容量・並列性、実配送・音声・再起動はこの確認では検証していない。取り込み元・Eumenesの製品コードは編集していない。

計画の本体: [always-on取り込み実装計画](../../agency-always-on-integration-plan-2026-11-08.md)。

## 文書の確認

計画書・本記録のローカル参照先の存在、課題IDと段階別受入の対応、再現結果のJSON構造、差分の空白エラーを確認した。実装計画と調査資料だけの追加のため、製品domain verify・ブラウザーE2E・実モデル評価は実行していない。既存の未コミット差分は保持し、索引には本計画の1行だけを追加した。
