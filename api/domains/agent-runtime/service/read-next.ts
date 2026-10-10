import { validators } from "../../capabilities";
import type { Source } from "../../tool-runtime";

type Operation = {
	tool?: string;
	state?: string;
	arguments?: unknown;
	notes?: unknown;
};
/** Small operational hints; citation identifiers stay in the evidence observations. */
export function bodyReadReferences(visible: Source[]) {
	return [
		...new Map(
			visible
				.filter((s) => s.sourceRef)
				.map((s) => [
					s.sourceRef,
					{
						sourceRef: s.sourceRef,
						title: s.title.slice(0, 100),
						url: s.url?.slice(0, 256),
					},
				]),
		).values(),
	].slice(-3);
}
/** Recommend a correction only when the mistaken ID names an already visible source. */
export function correctedRead(operations: Operation[], visible: Source[]) {
	const last = operations.at(-1);
	const toolId = last?.tool?.match(/^tool:(web\.find|web\.read_saved)@/u)?.[1];
	if (last?.state !== "failed" || !toolId) return null;
	const args = last.arguments as
		| { sourceRef?: string; query?: string }
		| undefined;
	const source = visible.find(
		(s) => s.sourceId === args?.sourceRef && s.sourceRef,
	);
	if (!source) return null;
	const validator =
		toolId === "web.find" ? validators.find : validators.readSaved;
	const parsed = validator.safeParse({
		...args,
		sourceRef: source.sourceRef,
	});
	return parsed.success
		? { action: "invoke", executionRef: toolId, arguments: parsed.data }
		: null;
}
/** A read cursor belongs to a find match, not to the find continuation. */
export function nextSavedRead(operations: Operation[], visible: Source[]) {
	for (const operation of [...operations].reverse()) {
		if (
			!operation.tool?.startsWith("tool:web.find@") ||
			operation.state !== "succeeded"
		)
			continue;
		const notes = operation.notes as
			| {
					sourceRef?: unknown;
					matches?: Array<{ cursor?: unknown; start?: number; end?: number }>;
			  }
			| undefined;
		for (const match of notes?.matches ?? []) {
			const input = validators.readSaved.safeParse({
				sourceRef: notes?.sourceRef,
				cursor: match.cursor,
				characters: 2400,
			});
			if (!input.success || !input.data.cursor) continue;
			if (
				visible.some(
					(s) =>
						s.basis === "page" &&
						s.sourceRef === input.data.sourceRef &&
						s.start !== undefined &&
						s.end !== undefined &&
						match.start !== undefined &&
						match.end !== undefined &&
						s.start <= match.start &&
						s.end >= match.end,
				)
			)
				continue;
			if (
				operations.some((o) => {
					const args = o.arguments as typeof input.data | undefined;
					return (
						o.tool?.startsWith("tool:web.read_saved@") &&
						o.state === "succeeded" &&
						args?.sourceRef === input.data.sourceRef &&
						args?.cursor === input.data.cursor
					);
				})
			)
				continue;
			return {
				action: "invoke",
				executionRef: "web.read_saved",
				arguments: input.data,
			};
		}
	}
	return null;
}
