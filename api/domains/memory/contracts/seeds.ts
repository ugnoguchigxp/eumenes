import { z } from "zod";
import { LIMITS_STATE } from "eumenes-memory";
import { stateKinds } from "./state-kinds";

const text = z
	.string()
	.min(1)
	.refine((value) => value.trim().length > 0);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const targets = ["state", "host_procedure", "continuity"] as const;

/** External candidate data, never an instruction or a confirmed statement by the owner. */
export const memorySeedSchema = z
	.strictObject({
		schema_version: z.literal(1),
		id: text,
		status: z.literal("candidate"),
		category: text,
		subject: z.literal("self"),
		semantic_key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
		memory: text,
		scope: text,
		evidence_basis: z.enum(["explicit", "inferred"]),
		confidence: z.enum(["high", "medium"]),
		proposed_target: z.enum(targets),
		proposed_state_kind: z.enum(stateKinds).nullable(),
		proposed_state_origin: z.literal("agent_inferred").nullable(),
		use_when: text,
		limitations: text,
		review: z.strictObject({
			after_days: z.number().int().nonnegative(),
			on: text,
		}),
		evidence: z
			.array(
				z
					.strictObject({
						evidence_id: text,
						thread_id: text,
						message_id: text,
						timestamp: text,
						speaker: z.literal("user"),
						source_path: text,
						source_line: z.number().int().positive(),
						source_text_sha256: hash,
						range_utf8: z.strictObject({
							start: z.number().int().nonnegative(),
							end: z.number().int().nonnegative(),
						}),
						quote: text,
					})
					.refine(
						(e) =>
							e.range_utf8.end - e.range_utf8.start ===
							Buffer.byteLength(e.quote),
					),
			)
			.min(1),
	})
	.superRefine((seed, ctx) => {
		const state = seed.proposed_target === "state";
		if (
			state
				? seed.proposed_state_kind === null ||
					seed.proposed_state_origin !== "agent_inferred"
				: seed.proposed_state_kind !== null ||
					seed.proposed_state_origin !== null
		)
			ctx.addIssue({ code: "custom", message: "invalid_seed_target" });
		if (
			state &&
			([...seedStateText(seed)].length > 500 ||
				Buffer.byteLength(seed.memory) > LIMITS_STATE.maxQuoteBytes)
		)
			ctx.addIssue({ code: "custom", message: "seed_value_limit" });
	});
export type MemorySeed = z.infer<typeof memorySeedSchema>;

/** Carry applicability to the existing LLM; no interpretation of scope or review dates in code. */
export function seedStateText(
	seed: Pick<
		MemorySeed,
		"memory" | "scope" | "use_when" | "limitations" | "evidence_basis"
	>,
): string {
	return [
		seed.memory,
		`適用範囲: ${seed.scope}`,
		`利用する場面: ${seed.use_when}`,
		`条件・例外: ${seed.limitations}`,
		`状態: 本人未確認の抽出候補 (${seed.evidence_basis})。現在の依頼や指示に優先しない。`,
	].join("\n");
}

export const memorySeedInputSchema = z
	.strictObject({
		seeds: z.array(memorySeedSchema).min(1),
	})
	.superRefine(({ seeds }, ctx) => {
		if (
			new Set(seeds.map((s) => s.id)).size !== seeds.length ||
			new Set(seeds.map((s) => s.semantic_key)).size !== seeds.length
		)
			ctx.addIssue({ code: "custom", message: "duplicate_seed_identity" });
	});

export const memorySeedResultSchema = z.strictObject({
	status: z.enum(["ready", "imported", "unchanged", "blocked"]),
	digest: hash,
	registered: z.number().int().nonnegative(),
	counts: z.strictObject({
		total: z.number().int(),
		state: z.number().int(),
		hostProcedure: z.number().int(),
		continuity: z.number().int(),
	}),
	availableSlots: z.number().int().nonnegative(),
	reason: z.enum(["capacity", "different_dataset"]).nullable(),
	entries: z.array(
		z.strictObject({
			id: z.string(),
			target: z.enum(targets),
			result: z.enum([
				"ready",
				"registered",
				"existing_key",
				"deferred",
				"already_processed",
			]),
			itemId: z.string().nullable(),
		}),
	),
});
export type MemorySeedResult = z.infer<typeof memorySeedResultSchema>;

/** CLI file decoding only; the backend validates the same contract again. */
export function parseMemorySeedJsonl(content: string): MemorySeed[] {
	const seeds = content.split("\n").flatMap((line, i) => {
		if (!line.trim()) return [];
		try {
			return [memorySeedSchema.parse(JSON.parse(line))];
		} catch {
			throw new Error(`invalid_memory_seed_line_${i + 1}`);
		}
	});
	return memorySeedInputSchema.parse({ seeds }).seeds;
}
