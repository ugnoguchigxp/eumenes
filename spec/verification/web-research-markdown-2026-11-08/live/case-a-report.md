# オフラインの個人用メモアプリ：IndexedDBとWeb Storageの選び方

## 結論
メモ本文や複数の項目を保存するなら、構造化データに対応し非同期で扱えるIndexedDBが有力です。テーマや表示設定など少量の単純な値には、キー・値形式のWeb Storageが簡便です。どちらもブラウザー内に保存する仕組みですが、データが必ず残る保証はありません。アプリ自体がオフラインで起動・動作するかは、保存APIの選択だけでは決まりません。

## 比較表
| 観点 | IndexedDB | Web Storage（localStorage / sessionStorage） |
|---|---|---|
| 同期・非同期 | 非同期のAPIで、トランザクション型データベースとしてデータを扱う。 | 同期的。読み書き中はJavaScriptの実行をブロックすることがある。 |
| 保存できるデータ | structured clone algorithmで複製可能なオブジェクトを保存できる。 | キー・値形式で保存する。 |
| 容量 | 一律の固定値ではなく、ブラウザー固有のストレージ管理・originごとの割当てによる。上限超過時は書き込みがQuotaExceededErrorになる場合がある。 | MDN記載では合計最大10 MiB。localStorage、sessionStorageそれぞれoriginあたり最大5 MiB。上限到達時はQuotaExceededError。 |
| 保存期間・削除 | 通常はbest-effortで保存され、容量や端末のストレージ圧迫などの条件でorigin単位のデータ退避が起きうる。永続化が許可されたデータはストレージ圧迫時の退避対象外だが、ユーザーによる削除は可能。 | localStorageはブラウザー終了後も残り、sessionStorageはタブを閉じると消える。ユーザーによるサイトデータ削除の対象で、ブラウザーの処理や退避条件は一律ではない。 |
| 個人用オフラインメモでの用途 | メモ本文、複数レコード、構造化された情報などに向く。 | 少量の設定値や、タブ単位で使い捨てる一時状態に向く。同期処理なので大きなデータの頻繁な読み書きには注意。 |

## 削除・容量についての注意
MDNは、Web Storageの上限を各5 MiB（localStorageとsessionStorage）と説明しています。一方、IndexedDBを含む他のストレージAPIの割当量はブラウザーごとに管理され、ブラウザーや状況によって異なります。したがって、すべての環境に共通するIndexedDBの容量値はこの資料からは示せません。

ブラウザー保存データは通常best-effortで、空き容量の圧迫などで退避される可能性があります。退避時には、そのoriginに保存されたデータ全体が削除される場合があります。`navigator.storage.persist()`による永続化の仕組みもありますが、ユーザーがブラウザー設定から削除することまでは防げません。書き込み時のQuotaExceededErrorを処理し、必要に応じてエクスポートやバックアップを検討してください。

## 判断できない点・限界
- IndexedDBの実際の利用可能容量や永続化の許可は、対象ブラウザー、端末、空き容量などに依存するため、ここでは特定できません。
- Web Storageの厳密な削除・退避挙動はブラウザー設定や実装に左右され、全ブラウザー共通の保証としては断定できません。
- 「オフラインで使える」ことは保存方式だけでは保証されません。アプリの起動に必要なHTML・JavaScript等をオフラインで利用できるようにする方法や、端末間同期の要件は今回の資料・調査範囲では評価していません。
- どちらの方式が最適かは、メモの量、データ構造、対応ブラウザー、バックアップ要件によって変わります。用途別の推奨はMDNが示すAPI特性からの判断であり、特定アプリの性能試験によるものではありません。

## 出典
- [IndexedDB API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)（非同期、トランザクション型、structured clone対応データ）
- [Web Storage API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API)（キー・値保存、同期処理、localStorageとsessionStorage）
- [Storage quotas and eviction criteria - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)（容量、best-effort／persistent、QuotaExceededError、退避）