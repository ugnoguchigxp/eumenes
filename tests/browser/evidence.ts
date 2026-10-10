import { resolve } from "node:path";

/** Evidence images go to test-results unless explicitly recorded into spec/verification. */
export function evidencePath(relative: string): string {
	const base =
		process.env.EUMENES_RECORD_EVIDENCE === "1"
			? "spec/verification"
			: "test-results/evidence";
	return resolve(base, relative);
}
