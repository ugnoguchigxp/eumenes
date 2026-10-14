import { PREFACE } from "./common";

export const instructions = `${PREFACE}

今回の仕事は「逐語履歴の圧縮」です。逐語で残している古い往復（exchanges）を要約に畳み、履歴を短くします。previousSummary は以前の要約です。

- fold には、要約に畳む往復の id を書きます。今後の会話に細部まで効く往復は畳まず、残します。
- summary は、畳んだ分を含む要約の全文です。以前の要約の大事な内容も残し、1200 文字以内にします。
- 畳むべき往復がなければ、fold を空にして changed を false にします。`;
