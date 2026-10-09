# T00 取得元の実現性 (2026-10-09 JST)

認証不要の公開取得(curl)で確認。Provider応答の丸ごと保存、secret記録なし。fixtureは観測した表記から最小化した。

| 対象 | 取得元 | 結果 |
| --- | --- | --- |
| AAPL | `https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d`(既存public-json経路) | 取得可。`meta`に symbol/currency/regularMarketPrice/regularMarketTime/exchangeTimezoneName/exchangeName(NMS)。host固定mappingでNMS→NASDAQ。市場を持たない/未知コードは `market_unverified`。**quote-json-v1: 対応(fixture+live形式確認)** |
| 鎌倉市(city) | JMA `forecast/data/forecast/140000.json`(既存経路) | 取得可だが予報区(東部/西部)単位。市粒度を満たさない → `granularity_unsupported` |
| 鎌倉市(city) | Yahoo!天気 `weather.yahoo.co.jp/weather/jp/14/4610/14204.html` (HTML) | HTTP 200。「鎌倉市の天気」ピンポイント(3時間毎の天気/気温、`YYYY年M月D日 HH時MM分発表`)と週間(日付/天気/最高・最低)。日別の最高/最低は週間表(翌々日以降)のみ。3時間値は日別極値ではないため最高/最低に使わない |
| 静岡市 | 同上 `22/5010/22101.html` | ページは「静岡市葵区」。市単位ページは確認できず、`location_mismatch` となる → **静岡市のlive対応は未確認(未対応)** |

## 有限表記と変換

HTMLページは `weatherPageText()`(web-research/service/source-text.ts)で1日1行の正規化資料へ変換する:
`<地点> <YYYY-MM-DD> 天気 <ラベル> [最高気温 N 最低気温 N] 発表 <ISO+09:00>`。
時間別は全時刻が同一ラベルの日だけ行にし、最高/最低は出さない。週間は日付・天気・気温対の個数が揃う時だけ行にする。
天気ラベルは 晴れ/曇り/雨/雪/雷雨/霧 の有限集合に写像し、「晴時々曇」等の複合は `condition_unmapped`(学習不可)。

## 未達・注意

- `weatherPageText` はllm-fetchの実HTML→text出力に対し未接続・未検証(adapters/llm-fetch.tsの配線は本作業の範囲外)。実テキストは tag除去後の観測形式でfixture化した。配線後にliveで再確認が必要。
- 鎌倉の「明日」は時間別が一様な日だけ、最高/最低気温の学習は週間表の日付のみ。要求項目が満たせない場合は `field_missing`/`date_mismatch` で再検索または通常回答。
- 静岡市、鎌倉明日の最高気温などは現時点でliveの対応を宣言しない。city対応完了は宣言しない。
