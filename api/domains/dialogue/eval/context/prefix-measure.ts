/**
 * Prefix stability of the arms on the trajectory (evaluation design section 5.4, ContextWindow design 7.2): the
 * trajectory's calls are rendered by each arm (and ordering variant), serialized the way the run's lane sends
 * them, and the shared prefix of every pair of consecutive calls is measured. The result is what criterion 7 of the
 * adoption rules reads; nothing is measured by hand.
 */
import { z } from "zod";
import type { ChatMessage } from "../../service/context";
import { type ContextArm, promptHash } from "./arm";
import { type PrefixStability, prefixStability } from "./prefix-stability";
import { SERIALIZATIONS, type Serialization } from "./raw";
import { assertRenderInvariants } from "./render-invariants";
import { serialize } from "./serialization";
import {
	type SeedWiring,
	CONVERSATION_ID,
} from "./materialize";
import {
	type Trajectory,
	type TrajectoryCallAssembly,
	DEFAULT_TRAJECTORY,
	materializeTrajectory,
} from "./trajectory";

/**
 * The host's own addition to the selection call (the candidate toolchains are retrieved in the execute phase, after
 * the prepare-time assembly). It is the same text for every arm and stands right before the current request.
 */
const SELECTION_NOTE =
	"選択肢となる担当の候補が提示されています。必要なら一つ選んで呼び出します。";

/** An arm's messages for one call of the trajectory, as the lane sends them. */
export function callMessages(
	arm: ContextArm,
	call: TrajectoryCallAssembly,
	serialization: Serialization,
): ChatMessage[] {
	const out = assertRenderInvariants(arm, call.assembly, call.label);
	if (call.kind === "selection") {
		const messages = [...out.messages];
		messages.splice(out.currentRequestIndex, 0, {
			role: "system",
			content: SELECTION_NOTE,
		});
		return serialize(serialization, {
			...out,
			messages,
			currentRequestIndex: out.currentRequestIndex + 1,
		}).messages;
	}
	return serialize(serialization, out).messages;
}

export const prefixArmSchema = z
	.object({
		/** Median of the token ratios of consecutive calls: what criterion 7 compares. */
		medianRatio: z.number().min(0).max(1).nullable(),
		medianByteRatio: z.number().min(0).max(1).nullable(),
		calls: z.array(
			z
				.object({
					label: z.string(),
					promptSha256: z.string(),
					bytes: z.number().int().min(0),
					tokens: z.number().int().min(0),
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
		serialization: z.enum(SERIALIZATIONS),
		conversationId: z.string(),
		arms: z.record(z.string(), prefixArmSchema),
	})
	.strict();
export type PrefixReport = z.infer<typeof prefixReportSchema>;

function armReport(
	messagesOfCalls: ChatMessage[][],
	labels: string[],
	stability: PrefixStability,
): z.infer<typeof prefixArmSchema> {
	return {
		medianRatio: stability.medianTokenRatio,
		medianByteRatio: stability.medianRatio,
		calls: messagesOfCalls.map((messages, i) => {
			const pair = i === 0 ? undefined : stability.pairs[i - 1];
			const bytes = Buffer.byteLength(JSON.stringify(messages));
			return {
				label: labels[i]!,
				promptSha256: promptHash(messages),
				bytes,
				tokens: pair ? pair.nextTokens : stability.firstTokens,
				sharedBytes: pair?.sharedBytes ?? null,
				sharedTokens: pair?.sharedTokens ?? null,
				tokenRatio: pair?.tokenRatio ?? null,
			};
		}),
	};
}

/** Measures every arm on one trajectory played on a fresh store (closed afterwards). */
export async function measurePrefix(options: {
	arms: readonly ContextArm[];
	serialization: Serialization;
	openWiring: () => Promise<SeedWiring>;
	trajectory?: Trajectory;
}): Promise<PrefixReport> {
	const wiring = await options.openWiring();
	let calls: TrajectoryCallAssembly[];
	try {
		calls = await materializeTrajectory(
			wiring,
			options.trajectory ?? DEFAULT_TRAJECTORY,
		);
	} finally {
		await wiring.close();
	}
	const arms: PrefixReport["arms"] = {};
	for (const arm of options.arms) {
		const messages = calls.map((call) =>
			callMessages(arm, call, options.serialization),
		);
		arms[arm.id] = armReport(
			messages,
			calls.map((c) => c.label),
			prefixStability(messages),
		);
	}
	return {
		format: "context-eval.prefix",
		serialization: options.serialization,
		conversationId: CONVERSATION_ID,
		arms,
	};
}
