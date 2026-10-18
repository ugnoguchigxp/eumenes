import { rewriteReferences, type TaskState } from "../../domains/inference";
import { clip } from "./browser-text";

/**
 * A page the task has left behind, in one line: where it was, its title and that it can no longer be used. The
 * element refs of an old observation are void (spec browser-tabs-toolchain §5.5, 2026-10-19), so its text only
 * costs the model's context.
 */
const stub = (observation: { place?: unknown; title?: unknown }) => {
	const place = typeof observation.place === "string" ? observation.place : "";
	const title =
		typeof observation.title === "string" ? clip(observation.title, 100) : "";
	return `失効済み: ${place} 「${title}」`.replace(/\s+/g, " ").trim();
};

/**
 * Call when a new observation is about to be appended: every observation already in the REFERENCE and in earlier
 * TOOL_RESULTs becomes its stub. The system layer, the request and the model's own outputs are not touched.
 */
export function expireObservations(core: TaskState): TaskState {
	return rewriteReferences(core, (data) => {
		if (!data || typeof data !== "object") return data;
		const held = data as Record<string, unknown>;
		const observation = held.observation;
		if (!observation || typeof observation !== "object") return data;
		return { ...held, observation: stub(observation) };
	});
}
