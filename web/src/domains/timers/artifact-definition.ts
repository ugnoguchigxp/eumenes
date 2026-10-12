export const timerSetupSource = "timer-setup";

export function timerSetupDefinition() {
	return JSON.stringify({
		view: "timer-workspace",
		source: timerSetupSource,
		title: "タイマーを開始",
	});
}

export function timerDefinition(timerId: string) {
	return JSON.stringify({
		view: "timer-workspace",
		source: `timer-${timerId}`,
	});
}
import { parseDefinition } from "@eumenes/artifact-ui/contracts";

export function timerArtifactSource(definition: string): string | null {
	try {
		const request = parseDefinition(definition);
		return request.view === "timer-workspace" &&
			request.source.startsWith("timer-")
			? request.source
			: null;
	} catch {
		return null;
	}
}
