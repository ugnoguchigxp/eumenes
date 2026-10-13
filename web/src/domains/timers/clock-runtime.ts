import { useCallback, useState } from "react";
import type { ArtifactRuntime } from "@eumenes/artifact-ui";
import type { Receipt, Snapshot } from "@eumenes/artifact-ui/contracts";
import { useStopwatch } from "./useStopwatch";

export function useClockWorkspace({
	source,
	visible,
}: {
	source: string | null;
	visible: boolean;
}) {
	const [selection, setSelection] = useState({
		source,
		mode: "timer" as "timer" | "stopwatch",
	});
	const mode = selection.source === source ? selection.mode : "timer";
	const stopwatch = useStopwatch(visible && mode === "stopwatch");
	// Adjust this screen session when its saved source changes, before rendering children.
	if (selection.source !== source) {
		setSelection({ source, mode: "timer" });
		if (source === null) stopwatch.reset();
	}
	const setMode = useCallback(
		(mode: "timer" | "stopwatch") =>
			setSelection((current) =>
				current.mode === mode ? current : { ...current, mode },
			),
		[],
	);
	return { mode, setMode, stopwatch };
}
export type ClockControls = ReturnType<typeof useClockWorkspace>;

/** UI-only clock operations remain distinct from the persisted timer API. */
export function withClockControls(
	runtime: ArtifactRuntime,
	controls?: ClockControls,
): ArtifactRuntime {
	if (!controls) return runtime;
	const snapshot: Snapshot = Object.fromEntries(
		Object.entries(runtime.snapshot).map(([source, data]) => [
			source,
			data.kind === "timer-workspace"
				? {
						...data,
						mode: controls.mode,
						stopwatch: {
							elapsedMs: controls.stopwatch.elapsedMs,
							running: controls.stopwatch.running,
						},
					}
				: data,
		]),
	);
	return {
		snapshot,
		dispatch: async (event): Promise<Receipt> => {
			if (
				![
					"clock-mode",
					"stopwatch-start",
					"stopwatch-stop",
					"stopwatch-reset",
				].includes(event.action)
			)
				return runtime.dispatch(event);
			const resource = runtime.snapshot[event.source];
			if (
				resource?.kind !== "timer-workspace" ||
				event.revision !== resource.revision
			)
				return {
					status: "rejected",
					message: "この時計の操作は利用できません",
				};
			switch (event.action) {
				case "clock-mode":
					if (
						event.values.mode !== "timer" &&
						event.values.mode !== "stopwatch"
					)
						return {
							status: "rejected",
							message: "時計の種類を確認してください",
						};
					controls.setMode(event.values.mode);
					break;
				case "stopwatch-start":
					controls.stopwatch.start();
					break;
				case "stopwatch-stop":
					controls.stopwatch.stop();
					break;
				case "stopwatch-reset":
					controls.stopwatch.reset();
					break;
			}
			return { status: "accepted", message: "" };
		},
	};
}
