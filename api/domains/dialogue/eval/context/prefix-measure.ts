/**
 * Prefix stability of the production messages on the trajectories (the ContextWindow specification, sections 12.4 and
 * 21.2): each trajectory's generations are prepared by the production code, and the shared prefix of every pair of
 * consecutive calls is measured. The result is what criterion 6 of the adoption rules reads; nothing is measured by
 * hand. A re-construction rewrites part of the document, so its call shares less (the document keeps its keys in
 * the order that changes least first); the median over the ordinary calls is the figure that is compared.
 */
import { z } from "zod";
import { estimateMessageTokens } from "../../../inference";
import {
	type PrefixStability,
	median,
	prefixStability,
	promptHash,
} from "./prefix-stability";
import { assertMessageInvariants } from "./message-invariants";
import { type EvalCard, type SeedWiring, CONVERSATION_ID } from "./session";
import {
	TRAJECTORIES,
	type TrajectoryName,
	playTrajectory,
} from "./trajectory";

const trajectoryReportSchema = z
	.object({
		/** Median of the token ratios of the ordinary calls (no re-construction before them): what criterion 6 compares. */
		medianRatio: z.number().min(0).max(1).nullable(),
		medianByteRatio: z.number().min(0).max(1).nullable(),
		/** Shared tokens over earlier-prompt tokens, summed over the conversation (supplementary). */
		aggregateRatio: z.number().min(0).max(1).nullable(),
		calls: z.array(
			z
				.object({
					label: z.string(),
					promptSha256: z.string(),
					bytes: z.number().int().min(0),
					tokens: z.number().int().min(0),
					/** Why the window was re-constructed before this call; null: an ordinary call. */
					reconstruction: z.string().nullable(),
					/** Shared with the previous call; null for the first. */
					sharedBytes: z.number().int().min(0).nullable(),
					sharedTokens: z.number().int().min(0).nullable(),
					tokenRatio: z.number().min(0).max(1).nullable(),
				})
				.strict(),
		),
	})
	.strict();
export const prefixReportSchema = z
	.object({
		format: z.literal("context-eval.prefix"),
		conversationId: z.string(),
		trajectories: z.record(z.string(), trajectoryReportSchema),
	})
	.strict();
export type PrefixReport = z.infer<typeof prefixReportSchema>;

/** The trajectory whose ordinary generations criterion 6 compares. */
export const COMPARED_TRAJECTORY: TrajectoryName = "default";

/** Measures every trajectory, each played on a fresh store (closed afterwards). */
export async function measurePrefix(options: {
	openWiring: () => Promise<SeedWiring>;
	catalog?: readonly EvalCard[];
}): Promise<PrefixReport> {
	const trajectories: PrefixReport["trajectories"] = {};
	for (const [name, trajectory] of Object.entries(TRAJECTORIES)) {
		const wiring = await options.openWiring();
		let calls: Awaited<ReturnType<typeof playTrajectory>>;
		try {
			calls = await playTrajectory(
				wiring,
				trajectory,
				options.catalog ? { catalog: options.catalog } : {},
			);
		} finally {
			await wiring.close();
		}
		for (const call of calls)
			assertMessageInvariants(call.input, `${name}:${call.label}`);
		const lists = calls.map((call) => call.input.messages);
		const stability: PrefixStability = prefixStability(lists);
		// The ordinary calls are the ones no re-construction preceded.
		const ordinary = stability.pairs.filter(
			(pair) => calls[pair.from + 1]!.reconstruction === null,
		);
		trajectories[name] = {
			medianRatio: median(ordinary.map((pair) => pair.tokenRatio)),
			medianByteRatio: median(ordinary.map((pair) => pair.ratio)),
			aggregateRatio: stability.aggregateTokenRatio,
			calls: lists.map((messages, i) => {
				const pair = i === 0 ? undefined : stability.pairs[i - 1];
				return {
					label: calls[i]!.label,
					promptSha256: promptHash(messages),
					bytes: Buffer.byteLength(JSON.stringify(messages)),
					tokens: estimateMessageTokens(messages),
					reconstruction: calls[i]!.reconstruction?.reason ?? null,
					sharedBytes: pair?.sharedBytes ?? null,
					sharedTokens: pair?.sharedTokens ?? null,
					tokenRatio: pair?.tokenRatio ?? null,
				};
			}),
		};
	}
	return {
		format: "context-eval.prefix",
		conversationId: CONVERSATION_ID,
		trajectories,
	};
}
