import {
	SLICE_MAX_BYTES,
	buildWorldSlice,
	type CanonicalHasher,
	type ProjectionSnapshot,
	type WorldSlice,
} from "eumenes-world-model";
import {
	TOPIC_BLOCK_MAX_BYTES,
	WORLD_MIN_BYTES,
	allocateContextBudget,
	renderWorldBlock,
	worldBlockBytes,
	type RenderTopic,
} from "./context-render";

/** Shrink-and-render rounds before the rendered block is declared an overflow. */
const MAX_FIT_ATTEMPTS = 6;

/** A content-free machine code the queue may persist (`^[a-z][a-z0-9_:]*$`). */
export const reasonOf = (code: string) =>
	`world_${code.toLowerCase().replace(/^world_/, "")}`;

export type FitResult =
	| { status: "fitted"; slice: WorldSlice; block: string; worldBytes: number }
	| { status: "disabled" }
	| { status: "blocked"; reason: string };

/**
 * Builds the Slice and renders its block. The slice is sized on its UNESCAPED JSON, the model sees the
 * ESCAPED block (up to 6x per character), so the rendered block is measured and the slice shrunk (whole
 * units are dropped by buildWorldSlice) until it fits; no room left means world_overflow. With
 * `topicNames` the block is the topic block: it names the targets and is capped at TOPIC_BLOCK_MAX_BYTES.
 */
export function fitSlice(options: {
	snapshot: ProjectionSnapshot;
	goalRef: { goalRef?: { id: string; revision: number } };
	totalBytes: number;
	reservedBytes: number;
	hasher: CanonicalHasher;
	topicNames?: (slice: WorldSlice) => RenderTopic[];
}): FitResult {
	const allocation = allocateContextBudget({
		totalBytes: options.totalBytes,
		reservedBytes: options.reservedBytes,
		sliceCapBytes: SLICE_MAX_BYTES,
		...(options.topicNames ? { blockCapBytes: TOPIC_BLOCK_MAX_BYTES } : {}),
	});
	if (!allocation.ok) return { status: "blocked", reason: "world_budget" };
	let worldBytes = allocation.worldBytes;
	for (let attempt = 0; ; attempt++) {
		if (attempt >= MAX_FIT_ATTEMPTS || worldBytes < WORLD_MIN_BYTES)
			return { status: "blocked", reason: "world_overflow" };
		const built = buildWorldSlice(
			{
				contractVersion: 1,
				snapshot: options.snapshot,
				request: { ...options.goalRef, maxBytes: worldBytes },
			},
			options.hasher,
		);
		if (!built.ok) return { status: "blocked", reason: "world_slice_invalid" };
		if (built.value.status === "disabled") return { status: "disabled" };
		if (built.value.status === "overflow")
			return { status: "blocked", reason: "world_overflow" };
		if (built.value.status === "blocked")
			return {
				status: "blocked",
				reason: reasonOf(built.value.reasonCodes[0] ?? "blocked"),
			};
		// Nothing to say: no usage, no receipt, no input dependency.
		if (built.value.units.length === 0) return { status: "disabled" };
		const rendered = renderWorldBlock(
			built.value,
			options.topicNames?.(built.value) ?? [],
		);
		const size = worldBlockBytes(rendered);
		if (size <= allocation.blockLimitBytes)
			return {
				status: "fitted",
				slice: built.value,
				block: rendered,
				worldBytes: allocation.worldBytes,
			};
		worldBytes -= size - allocation.blockLimitBytes;
	}
}
