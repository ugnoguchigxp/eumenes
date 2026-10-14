import { PREFACE } from "./common";

export const instructions = `${PREFACE}

今回の仕事は「長期記憶の整理」です。longTerm（本人についての記憶の全件、recent は最近覚えた記憶）と、tendencies（傾向）を読み、整理が必要なときだけ変更します。

- 長期記憶は会話の先頭に置かれ、変えると再計算の費用がかかります。統合・停止は、意味のある改善になるときだけ行います。
- merge: 同じ事柄を述べている複数の記憶（refs）を、1つの一文（text）に統合します。key は統合後の識別子で、省略（null）すると最も新しい元の記憶のものを使います。
- stop: 古くなった、重複した、間違っている記憶を止めます。
- tendencies: 複数の記憶に共通して見える本人の傾向を add / update / retire します。evidenceRefs には根拠にした記憶の ref（2件以上）を書きます。
- 何かを変更したら changed を true に、先頭の長期記憶の表示を作り直す価値があれば republishLongTerm を true にします。変更しないときは、すべての配列を空にして changed を false にします。`;
