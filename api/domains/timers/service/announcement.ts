/** A factual completion notice; it never needs another model call. */
export function timerCompletionMessage(timer: {
	label: string;
	durationSeconds: number;
}) {
	const hours = Math.floor(timer.durationSeconds / 3600);
	const minutes = Math.floor((timer.durationSeconds % 3600) / 60);
	const seconds = timer.durationSeconds % 60;
	const duration = `${hours ? `${hours}時間` : ""}${minutes ? `${minutes}分` : ""}${seconds ? `${seconds}秒` : ""}`;
	return timer.label === "タイマー"
		? `${duration}のタイマーが終了しました。`
		: `「${timer.label}」のタイマー（${duration}）が終了しました。`;
}
