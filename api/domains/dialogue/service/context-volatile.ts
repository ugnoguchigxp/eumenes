import type { ContextBlock } from "../../inference";
import type { ContextAssembly } from "./context-assembly";

/**
 * The pieces of what holds for one call only, as the prepare phase gathers them. The two that read the store with
 * a side effect or a cost (`worldNames`, `specialist`) are functions, so they run only when the answer being phrased
 * wants them.
 */
export type VolatileParts = {
	/** What memory decided (the notices and the prefetch): `ContextAssembly.volatile` as `compileAssembly` made it. */
	memory: readonly ContextBlock[];
	/**
	 * The answer of a sub-agent this run phrases, when there is one: a failed research (`failureCode`), a research
	 * report, or the result of an action (`actionPayload`).
	 */
	answer?: { failureCode?: string | null | undefined; actionPayload?: unknown };
	/** The World names this turn's wording mentions; null when there are none or World is unusable. */
	worldNames(): ContextBlock | null;
	/** The specialist records (work, viewing, handoff); [] when specialists are not offered to this run. */
	specialist(): ContextBlock[];
	/** The operation results, in the order they are shown. */
	operations: readonly ContextBlock[];
	/** The research report (`research.result`) or the failure record (`research.failure`), when there is one. */
	research: ContextBlock | null;
};

/**
 * The assembly with its volatile part (V), in the order the prepare phase shows it: the notices and the prefetch,
 * the World names, the specialist records, the operation results, the research record. A failed research answer
 * has no notices or prefetch and no World names (it keeps its own context apart from the layers); an answer that
 * is a failure or an action has no World names either; any sub-agent answer has no specialist records. The stage is
 * `result` while an answer or an operation result is phrased.
 */
export function withVolatile(
	assembly: ContextAssembly,
	parts: VolatileParts,
): ContextAssembly {
	const { answer } = parts;
	const worldNames =
		answer?.failureCode || answer?.actionPayload ? null : parts.worldNames();
	const volatile: ContextBlock[] = [
		...(answer?.failureCode ? [] : parts.memory),
		...(worldNames ? [worldNames] : []),
		...(answer ? [] : parts.specialist()),
		...parts.operations,
		...(parts.research ? [parts.research] : []),
	];
	return {
		...assembly,
		stage: answer || parts.operations.length ? "result" : "initial",
		volatile,
	};
}
