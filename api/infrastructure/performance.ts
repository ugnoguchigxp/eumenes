import { getLogger, withLogContext, type LogFields } from "./logger";

/** Operational boundaries only: never pass input, output, settings or raw errors. */
export async function measureStage<T>(
	component: string,
	phase: string,
	work: () => Promise<T>,
	fields: LogFields = {},
): Promise<T> {
	return withLogContext(fields, async () => {
		const started = performance.now();
		let outcome = "error";
		try {
			const result = await work();
			outcome = "ok";
			return result;
		} finally {
			try {
				getLogger(component).info("performance.stage", {
					phase,
					outcome,
					durationMs: performance.now() - started,
				});
			} catch {
				// A diagnostic sink must not change execution or cancellation.
			}
		}
	});
}
