import { PREFACE } from "./common";

export const instructions = `${PREFACE}

今回の仕事は「世界の記録」です。入力の utterances（発言。e1 など）を読み、本人の外の世界（プロジェクト、サービス、物、場所、他の人）についての、今後の判断に役立つ状態・関係・依存・因果を、claims に書きます。入力には、記録済みの entities（対象。w1 など）と claims（主張。c1 など）があります。

- 書くのは本人の外の世界のことだけです。本人の好み・習慣・事実（本人について）は書きません（それは別の担当の仕事です）。目標も書きません。
- 本人（user）の発言を根拠にしたことは origin を user_report にします。アシスタント（assistant）の説明や推測を根拠にしたことは origin を model_hypothesis にします。アシスタントの発言を user_report にしません。
- 主語（subject）は、entities にある対象の ref（w1 など）を使います。新しい対象は entities に name と aliases を書いて登録し、claims では new:0（entities の何番目か）で指します。同じ名前というだけで別の対象を同じものにしません。どの対象か決められないときは、その主張を書きません。
- claims の op: assert（新しい主張）、correct（既にある主張 ref を訂正）、retract（既にある主張 ref を取り消す）。correct と retract は ref に c1 などを書きます。本人が「それは違う」と言ったことは retract です。
- 「AをするとBが減る・増える・できるようになる」「AはBに依存する」のような方法と効果・原因と結果・依存は、relation の kind（decreases、increases、enables、causes、inhibits、depends_on）で書きます。アシスタントが方法や対策を説明したときは、その効果の見立てを model_hypothesis の relation として書きます（例: キャッシュ decreases 応答の遅延）。「関係がある」だけの related_to は、ほかに書きようがないときだけ使います。
- 値の主張は predicate と value、関係の主張は relation（kind と object。object は w1 または new:0）を書きます。relation のときの predicate は relation の kind と同じでかまいません。value は type が string のとき text、boolean のとき flag、number のとき number と unit を書き、使わない項目は null にします。relation を書くとき value は null です。
- evidence には根拠にした発言の id（e1 など）を書きます。validFrom / validUntil は YYYY、YYYY-MM、YYYY-MM-DD のどれかで、分からなければ null です。
- 分からないことは書きません。書くものがなければ entities と claims を空にして、changed を false にします。上限は、対象の登録 4 件、主張 8 件です。`;
