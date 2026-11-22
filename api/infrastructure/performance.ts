import { getLogger, withLogContext, type LogFields } from "./logger";

/** Operational boundaries only: never pass input, output, settings or raw errors. */
export function recordStage(
	component: string,
	phase: string,
	started: number,
	outcome: "ok" | "error",
	fields: LogFields = {},
) {
	try {
		getLogger(component).info("performance.stage", {
			...fields,
			phase,
			outcome,
			durationMs: performance.now() - started,
		});
	} catch {
		// A diagnostic sink must not change execution or cancellation.
	}
}

/** Keeps synchronous work, including SQLite transaction callbacks, synchronous. */
export function measureSyncStage<T>(
	component: string,
	phase: string,
	work: () => T,
	fields: LogFields = {},
): T {
	const started = performance.now();
	let outcome: "ok" | "error" = "error";
	try {
		const result = work();
		outcome = "ok";
		return result;
	} finally {
		recordStage(component, phase, started, outcome, fields);
	}
}

/** Operational boundaries only: never pass input, output, settings or raw errors. */
export async function measureStage<T>(
	component: string,
	phase: string,
	work: () => Promise<T>,
	fields: LogFields = {},
): Promise<T> {
	return withLogContext(fields, async () => {
		const started = performance.now();
		let outcome: "ok" | "error" = "error";
		try {
			const result = await work();
			outcome = "ok";
			return result;
		} finally {
			recordStage(component, phase, started, outcome);
		}
	});
}
