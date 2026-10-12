export const timerSetupSource = "timer-setup";

export function timerSetupDefinition() {
	return JSON.stringify({
		view: "form",
		source: timerSetupSource,
		title: "タイマーを開始",
	});
}
