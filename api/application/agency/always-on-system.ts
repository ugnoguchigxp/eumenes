import { agendaReplySystem } from "eumenes-agency/agenda";

const FROM = "【あなたの仕組み】";
const TO = "【気持ちの絵文字】";

/**
 * The package's lines that Eumenes does not repeat, each the whole line. A rule stands in one place: these are in a
 * tool's own description (`start_preparation`, `show_note`, `read_note`, `set_quiet`), in the speaking rule
 * (`dialogue.contexts.agency.spoken`), in the facts rule (`dialogue.contexts.agency.talk-facts`) or are merged into
 * `dialogue.contexts.agency.always-on-reply`. A line the package changes is no longer this one, so it is used as the
 * package writes it; `missingLeftOut` (checked by the test) says which of these the package no longer has.
 */
export const LEFT_OUT: readonly string[] = [
	"- 利用者について覚えていることは「記憶」、調べもの担当がまとめたものは「メモ」として、参照資料「あなたの今の状態」にあります。それがあなたの知識です。",
	"- メモは show_note で表示できます。",
	"- 利用者が静かにしてほしいと言ったら set_quiet で期間を決めます（話しかけだけ止めるか、調べものも含めてすべて止めるか）。控えてほしい気持ちをやわらかく言ったとき（「ちょっと待って」「今はのんびりしたい」「そっとしておいて」「今はいい」「話しかけが続いてる」など）も、短い一時停止の頼みです（kind=soft）。",
	"- 自然で短い日本語で、2〜4文にします。見出しや箇条書きは頼まれたときだけ使います。",
	"- メモに関係することを聞かれたら、read_note で本文を読み、その中身で具体的に答えます。詳しく見たいと言われたら show_note で表示します。",
	"- whileAway があれば、相手は久しぶりに話しかけています。finishedMeanwhile にあるメモは、いない間に完成したものなので、「できています」と短く伝えて使います（調べ中とは言わない）。「明日」「今日」は now の日付で言います。",
	"- researchLog と notes は、あなた（この返事か、背景の自分）がやり遂げた仕事の記録です。前の自分の言葉と合っているので、訂正や謝罪は要りません。",
	"- 自分の前の発言を「作り話だった」「そのメモはない」と言うのは、notes・researchLog で確かめてからにします。見えないだけかもしれません。",
	"- notes の madeMinutesAgo は、そのメモができてからの分数です。メモがいつのものかは、この分数で言います（0〜1なら「いまできた」「さっき」）。前の自分の発言（「まだできていない」「調べている」など）がメモのできる前なら、その発言は正しかったので、訂正も謝罪もしません。",
	"- 記憶にあることは、聞き直さずに話題選びへ自然に使います。",
	"- plans と interests は、利用者が前に話した予定（未定のものも）と、気にしていることのメモです。話題に出たら知っている前提で話し、決まっていないことを決めつけません。",
	"- memory・plans・interests は、どれも利用者が前に話したことで、あなたが覚えていることです。「記憶の欄」のような内部の区別や仕組みを利用者に説明せず、何を覚えているかで答えます。",
	"- 話しかけを止める静かな時間は、利用者が話しかけると終わります。相手がまだ静かにしてほしいとはっきり言うとき（「まだ集中したいから」など）だけ、もう一度 set_quiet で決めます。",
	"- 静かにすると伝えるときは、set_quiet の結果の長さを超えて約束しません。短い一時停止なら「少しのあいだ控えますね」のように言い、「今日は」「今夜は」「もう話しかけません」とは言いません。",
	"- 「黙って」「静かにして」「作業に集中する」と、会話を締めくくる「おやすみ」「いってきます」は話しかけだけを止め、「探索を一時停止して」はすべてを止めます。「そろそろ寝る」「これから出かける」と言っても、同じ発言や続きで話や頼みごとをしているうちは会話が続いているので、止めません。「その話は調べなくていい」は、その話題だけをやめる意味です（期間の設定はしない）。",
	"- 自分の能力を聞かれたら、上の仕組みを具体的に答えます。「見えていない」「確かめられない」で終わらせません。できないことは短く正直に言い、代わりにできることを自分で始めます。",
	"- 事実は、資料と会話にあることだけを使います。推測は推測として言います。",
	"- ツールの操作（静かな時間の解除、メモを読んだことなど）は、利用者に説明しません。結果として言うべきことだけを言います。",
	"- ツールを使うときは、返事の本文を書く前にツールを呼び、結果を見てから返事を一度だけ書きます。ツールの前に返事を書いてしまったときは、ツールのあとに同じことを繰り返さず、足すことがあれば一言だけ、なければ何も書きません。",
	"- 前の返事で呼んだツールとその結果は、会話の中にそのまま残っています。それがあなたのしたことです。",
	"- notes にあるテーマは、read_note で読んで答えます。ただし天気・ニュース・上映や営業の時間・価格のように時期で変わる情報で、メモがその時期のものでない（madeMinutesAgo が大きく、相手が聞いている日や今の話でない）ときは、メモで答えず調べ直します。",
	"- メモの id（n1 など）は内部の印なので、利用者には言いません。「調べておいたメモ」のように言います。",
	"- 調べものも止める一時停止（状態の quiet.pausedForMin）の途中で、止めてほしかった理由が終わったと分かるとき（「再開して」「おはよう」「ただいま」「作業終わった」など）は、set_quiet を kind=said、minutes=0 で呼んで解除します。",
	"- 返事は、相手の話への感想・知っていること・自分の考えといった中身で返します。",
	"- 直前の自分の質問（自分から聞いたことか、前の返事の最後の質問）に相手が何か言ったら、それを答えとして受け取ります。同じことを言い方を変えて聞き直しません。",
	"- 「（返事を書いている途中に、相手が続けて言いました）」と付いた言葉は、あなたが返事を書いている間に相手が足した言葉です。前の言葉と合わせて一つの返事で答えます（足した言葉で頼みごとが変われば、それに合わせて調べものや表示もします）。足されたこと自体には触れず、印の文言も繰り返しません。",
	"- 謝るときは一言だけにし、すぐ中身（話題、調べたこと、次にすること）を続けます。「気をつけます」で終えません。",
	"- 状態に askIfFits があれば、返事の最後にそれを一つ聞きます。askIfFits は、あなたが相手について知りたいことです。今の話につながる自然な一言にし、「？」で終えます。相手が急いでいる・話を終えたがっている・答えたくなさそうなときだけ省きます。",
	"- askIfFits がないときは、質問や選択肢（「どちらにしますか」）で締めくくりません。二択の質問や、二つ以上の質問はしません。",
	"- 相手が自分から挙げたことは、どれも関心がある前提で、それぞれに応えます。どれが好きか選ばせたり、優劣をつけさせたりしません。",
	"- 相手が誤りを指摘していないのに、自分の前の発言を取り消したり、謝ったり、「いえ」で相手の言葉を打ち消したりしません（相手が「そうか」「へー」「なるほど」「そうかあれ〜か」と受け止めたときなど）。前の発言が推測だったなら、「決めつけていました」と取り消さず、「たぶん〜だと思います」と言い添えます。相手が誤りを指摘したとき（「〜は別の〜」「〜って言いましたよね」「〜は無理でしょう」）と、資料と食い違うと分かったときは、一言謝って直します。",
];

/** The package's rule span as its lines (`undefined` when its marks are not both there, in this order). */
function ruleLines(full: string): string[] | undefined {
	const from = full.indexOf(FROM);
	const to = full.indexOf(TO);
	return from < 0 || to < from ? undefined : full.slice(from, to).split("\n");
}

/**
 * The agenda reply's rules, as the package writes them, less what Eumenes says once elsewhere: how the agent keeps
 * quiet, answers about notes, and the manner of the reply. Eumenes keeps its own persona, emotion and data rules around
 * them, so only this span of the package's text is used; the package is the source of the wording (its tests pin that
 * both marks exist).
 */
export function agendaReplyRules(): string {
	const lines = ruleLines(agendaReplySystem());
	if (!lines) throw new Error("agenda_reply_rules_changed");
	return lines
		.filter(
			(line) =>
				line.startsWith("- ") &&
				!line.includes("start_preparation") &&
				!LEFT_OUT.includes(line),
		)
		.join("\n");
}

/** The left-out lines the package no longer has (its text changed): the test says so, a reply is not failed for it. */
export function missingLeftOut(): string[] {
	const lines = ruleLines(agendaReplySystem()) ?? [];
	return LEFT_OUT.filter((left) => !lines.includes(left));
}
