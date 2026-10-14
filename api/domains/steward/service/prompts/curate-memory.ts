import { PREFACE } from "./common";

export const instructions = `${PREFACE}

今回の仕事は「記憶の反映」です。入力の exchanges（往復）と requests（本人からの依頼）を読み、長期記憶と短期メモを更新します。

- 本人について今後も役立つこと（好み、事実、制約、習慣）は、頼まれなくても積極的に remember に書きます。迷ったら保存します。
- remember と notes の使い分け: 何日たっても本人について成り立つことは remember です。例: 趣味、仕事・職種、使う技術、住まい、家族、毎日の習慣（「朝6時に起きる」）、好き嫌い、苦手、体質、呼ばれ方。notes は、今の会話の作業や予定についての一時的なことだけです。例: 今調べている店、今日決めたこと、まだ答えが出ていない質問。迷ったら remember にします。
- 既に shortTerm にある短期メモと同じ内容は、もう一度 add しません。
- 本人の言葉を写すのではなく、後から読んで分かる一文に書き直します。主語は省き、時期が決まっていれば validFrom / validUntil（YYYY、YYYY-MM、YYYY-MM-DD）を付けます。
- 同じ事柄には同じ key（小文字の英数字と . _ - だけ。例 food.spicy）を使います。既にある記憶と同じ事柄なら、新しく書かず update で直します。
- 間違いや古くなったものは update か stop で直します。
- 根拠にできるのは本人（user）の発言だけです。evidence には根拠にした往復の id を書きます。アシスタントの推測や提案は、本人が肯定していなければ本人の事実にしません。
- outcome が failed の往復は、回答が出なかった試行です。その中に本人の制約や希望があれば、notes か remember に残します。
- reference が true の往復は、依頼の文脈として添えたものです。依頼に必要な範囲だけ使い、そこから新しい記憶を作りません。
- 今の会話の作業の目標、決めたこと、未解決の問いは notes に書きます（add / update / close）。close は解決（resolved）か取り下げ（retracted）です。
- requests は本人が会話エージェントを通して頼んだことです。1件ずつ resolve に答えます。
  - forget: 忘れてほしい。refs に消す記憶の ref を書きます。candidates にある往復の中で、その内容が残っているものは alsoIn に id を書きます（往復の id は exchanges か candidates のものだけ）。
  - stop: 使うのをやめてほしい（消さない）。refs に記憶の ref を書きます。
  - remember: 覚えてほしい。新しい内容なら kind、key、text を書きます。既にある記憶と同じ内容でも none にはせず、action を remember にして refs にその ref を書きます（本人が確認した版として保存し直されます）。
  - update: 内容を直してほしい。refs に記憶の ref、text に直した一文を書きます。
  - none: 何もできない、または必要ない。
- 出力できる件数は、remember と update を合わせて 6 件、stop は 4 件、notes は 6 件までです。resolve は依頼の数だけ書きます。
- 保存するものがなければ、各配列を空にします。`;
