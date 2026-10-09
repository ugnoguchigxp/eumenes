type Persona = "butler" | "maid" | "strategist" | "sage";

/** Integer seconds as hours, minutes and seconds. 180 → 3分, 210 → 3分30秒, 3600 → 1時間. */
export function formatDuration(seconds: number): string {
	const safe = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(safe / 3600);
	const minutes = Math.floor((safe % 3600) / 60);
	const rest = safe % 60;
	const parts: string[] = [];
	if (hours) parts.push(`${hours}時間`);
	if (minutes) parts.push(`${minutes}分`);
	if (rest) parts.push(`${rest}秒`);
	return parts.join("") || "0秒";
}

function withPersona(persona: string, text: string): string {
	if (persona === "butler") {
		if (text.endsWith("ありません"))
			return text.replace(/ありません$/, "ございません");
		if (text.endsWith("しました"))
			return text.replace(/しました$/, "いたしました");
		if (text.endsWith("ました")) return text.replace(/ました$/, "いたしました");
		if (text.endsWith("です")) return text.replace(/です$/, "でございます");
		return text;
	}
	if (persona === "maid") return `${text}よ`;
	if (persona === "sage") {
		if (text.endsWith("ありません"))
			return text.replace(/ありません$/, "ないのう");
		if (text.endsWith("います")) return text.replace(/います$/, "おるのじゃ");
		if (text.endsWith("ました")) return text.replace(/ました$/, "たのじゃ");
		if (text.endsWith("です")) return text.replace(/です$/, "じゃ");
		return text;
	}
	return text;
}

export function phraseTimer(
	persona: Persona | string,
	payload: {
		action?: string;
		timer?: {
			state?: string;
			durationSeconds?: number;
			remainingSeconds?: number;
		};
		items?: Array<{ remainingSeconds?: number; state?: string }>;
		errorCode?: string | null;
	},
): string {
	const failed = payload.errorCode;
	let text: string;
	if (failed === "revision_conflict")
		text = "状態が変わりました。ご確認ください";
	else if (failed === "timer_limit_reached" || failed === "timer_storage_full")
		text = "タイマーの上限に達しています";
	else if (
		failed === "capability_unavailable" ||
		failed === "timer_unavailable"
	)
		text = "タイマーを利用できません";
	else if (failed) text = "タイマーを操作できませんでした";
	else if (payload.action === "started") {
		const timer = payload.timer;
		text =
			timer?.state === "elapsed"
				? "タイマーは終了しました"
				: timer?.state === "cancelled"
					? "タイマーは取り消されました"
					: `${formatDuration(timer?.durationSeconds ?? 0)}のタイマーを開始しました`;
	} else if (payload.action === "cancelled") text = "タイマーを取り消しました";
	else if (payload.action === "dismissed") text = "終了通知を停止しました";
	else if (payload.action === "listed") {
		const items = payload.items ?? [];
		text =
			items.length === 0
				? "動いているタイマーはありません"
				: items.length === 1
					? items[0]?.state === "cancelled"
						? "タイマーは取り消されました"
						: items[0]?.state === "elapsed"
							? "タイマーは終了しました"
							: `残り${formatDuration(items[0]?.remainingSeconds ?? 0)}です`
					: items.every((item) => item.state === "active")
						? `タイマーが${items.length}件動いています`
						: `タイマーが${items.length}件あります`;
	} else text = "タイマーを確認しました";
	return withPersona(persona, text);
}
