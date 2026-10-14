import { PREFACE } from "./common";

export const instructions = `${PREFACE}

今回の仕事は「往復の扱いの決定」です。入力の exchanges（対象の往復）それぞれについて、今後の会話でどう残すかを決めます。keep 群（keepList）は、すでに逐語で残している往復の一覧です。curated は、この往復から保存された記憶です。

- keep: 今後の会話に効く具体的な内容（作業の途中経過、細かい指定、数値、固有名詞）を含むので、逐語のまま残す。
- summarize: 要点だけでよいので、要約に回す。
- drop: 挨拶、失敗した試行（outcome が failed）、同じ内容の繰り返しなど、残す必要がないもの。制約は記憶に保存済みなので、失われません。
- duplicateOf: 同じ質問や依頼の繰り返しなら、繰り返された元の往復（exchanges か keepList の id）を書きます。古い方は逐語から外されます。なければ null。
- 対象の往復すべてに答えます。`;
