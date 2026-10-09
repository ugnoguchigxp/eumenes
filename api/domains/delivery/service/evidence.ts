import type { DeliveryContext, Emotion } from "../contracts";

/** Quoted text and code are descriptions, not the assistant expressing that feeling. */
export function expressionText(value: string) {
	return (
		value
			.replace(/```[\s\S]*?```/g, " ")
			.replace(/`[^`]*`/g, " ")
			.replace(/[「『“"][^」』”"\n]*[」』”"]/g, " ")
			.replace(/^\s*>.*$/gm, " ")
			// A definition names a feeling without expressing it. Keep other sentences.
			.replace(
				/[^。！？!?\n]*(?:とは|の意味は|という(?:言葉|表現)は)[^。！？!?\n]*[。！？!?]?/g,
				" ",
			)
	);
}

/** Evidence only narrows the choices. Laya must still select against neutral. */
export function emotionCandidates(
	text: string,
	context?: DeliveryContext,
): Exclude<Emotion, "none">[] {
	const response = expressionText(context?.answer || text);
	const user = expressionText(
		context?.turns.filter((turn) => turn.role === "user").at(-1)?.text ?? "",
	);
	const candidates = new Set<Exclude<Emotion, "none">>();
	const distress =
		/亡く|失っ|寂し|悲し|つら|辛い|苦し|不安|疲れ|しんど|落ち込|失敗|責め|喜べな|うれしくな|嬉しくな/.test(
			user,
		);
	const achievement =
		/合格|優勝|成功|達成|できた|出来た|うまく|うれし|嬉し|やった|良い知らせ|いい知らせ/.test(
			user,
		);
	const comfort =
		/無理.{0,8}(?:しない|せず|せない|しなく|なく)|大丈夫|ゆっくり|休んで|休んだ|背負|一緒に整理|いたわ|お疲れ|おつかれ|お気持ち|一息|ひと息|残念|しんどかった|つらかった|寂しい|悲しい/.test(
			response,
		);
	if (distress && comfort) candidates.add("empathy");
	if (
		/素敵|すてき|ありがとう|感謝|お役に立|おはよう|こんにちは|こんばんは|よろしく|親しみ|あたたか|温か|大切な.{0,12}(?:名前|思い出)|大切に(?:し|受け)/.test(
			response,
		)
	)
		candidates.add("warmth");
	const negatedJoy =
		/(?:嬉し|うれし|喜べ|喜ば|楽しく).{0,8}(?:ない|なかった|ません|なく)/.test(
			response,
		);
	if (
		!negatedJoy &&
		/おめでとう|やった[！!。]|よかった[！!。]|喜べて|嬉しい|うれしい/.test(
			response,
		)
	) {
		if (achievement || /おめでとう|やった[！!。]/.test(response))
			candidates.add("joy");
		else if (!distress) candidates.add("warmth");
	}
	if (
		/興味|面白そう|おもしろそう|聞かせて|きかせて|もっと.{0,8}知り|ぜひ.{0,8}(?:聞き|知り)|どんな.{0,40}[?？]/.test(
			response,
		)
	)
		candidates.add("curiosity");
	if (
		/驚き|驚いた|びっくり|予想外|まさか|えっ[、！!]|なんと[、！!]/.test(
			response,
		)
	)
		candidates.add("surprise");
	return [...candidates];
}
