/**
 * The run loop: materialize each case once, build every arm's messages from the same content, call the model
 * in Williams-balanced arm order with bounded concurrency, and emit one raw row per call.
 * No retries, no voting, no caching: a failed call is a row with status `transport_error`.
 */
import { createHash } from "node:crypto";
import type { ChatMessage } from "../../service/context";
import { type ContextArm, promptHash } from "./arm";
import type { ContextCase } from "./case-schema";
import type { ToolCallRecord } from "./checks";
import { type SeedWiring, materialize } from "./materialize";
import { type Lane, type RawRow, estimateTokens } from "./raw";

/** Williams design: every arm precedes every other equally often (twice for an odd count). */
export function williamsOrders(n: number): number[][] {
	if (n <= 0) return [];
	if (n === 1) return [[0]];
	const first = [0];
	let low = 1;
	let high = n - 1;
	for (let i = 1; i < n; i++) first.push(i % 2 === 1 ? low++ : high--);
	const rows = Array.from({ length: n }, (_, shift) =>
		first.map((value) => (value + shift) % n),
	);
	return n % 2 === 0
		? rows
		: [...rows, ...rows.map((row) => [...row].reverse())];
}

export type ConversationCall = {
	caseId: string;
	arm: string;
	trial: number;
	messages: ChatMessage[];
	tools: ContextCase["tools"];
};
export type ConversationOutcome =
	| { kind: "ok"; text: string; toolCalls: ToolCallRecord[]; repaired: boolean }
	| { kind: "contract_failure"; code: string; repaired: boolean };
/** Performs one conversation call. A thrown error is a transport error. */
export type ConversationRunner = (
	call: ConversationCall,
	signal: AbortSignal,
) => Promise<ConversationOutcome>;

type Job = {
	order: number;
	caseId: string;
	trial: number;
	arm: ContextArm;
	messages: ChatMessage[];
	unsupportedSeeds: string[];
	tools: ContextCase["tools"];
};

export type RunOptions = {
	lane: Lane;
	cases: readonly ContextCase[];
	arms: readonly ContextArm[];
	trials: number;
	/** Clamped to 1..2. */
	concurrency: number;
	openWiring: () => Promise<SeedWiring>;
	runner: ConversationRunner;
	onRow: (row: RawRow) => void;
	timeoutMs?: number;
	clock?: () => number;
	/** Run only the calls this accepts (a sanctioned re-run of transport errors). The order stays the full plan's. */
	only?: (call: { arm: string; caseId: string; trial: number }) => boolean;
	/**
	 * The frozen baseline prompts. The baseline arm is rebuilt for every case and must give the same
	 * sha256; a difference means product prompt building changed after the freeze, and the run stops.
	 */
	baseline?: { arm: string; prompts: Record<string, string> };
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The jobs in execution order. Pure, so the order is testable. */
export async function planJobs(
	options: Pick<
		RunOptions,
		"cases" | "arms" | "trials" | "openWiring" | "only" | "baseline"
	>,
): Promise<Job[]> {
	const orders = williamsOrders(options.arms.length);
	const jobs: Job[] = [];
	let order = 0;
	for (const [caseIndex, testCase] of options.cases.entries()) {
		const m = await materialize(testCase, await options.openWiring());
		try {
			const built = options.arms.map((arm) => ({ arm, out: arm.build(m) }));
			if (options.baseline) {
				const base = built.find((b) => b.arm.id === options.baseline!.arm);
				const frozen = options.baseline.prompts[testCase.id];
				if (!base) throw new Error("context_eval_baseline_arm_missing");
				if (frozen === undefined)
					throw new Error(
						`context_eval_baseline_prompt_unfrozen:${testCase.id}`,
					);
				if (promptHash(base.out.messages) !== frozen)
					throw new Error(
						`context_eval_baseline_prompt_changed:${testCase.id}`,
					);
			}
			for (let trial = 1; trial <= options.trials; trial++) {
				const sequence =
					orders[(caseIndex * options.trials + trial - 1) % orders.length]!;
				for (const armIndex of sequence) {
					const { arm, out } = built[armIndex]!;
					jobs.push({
						order: order++,
						caseId: testCase.id,
						trial,
						arm,
						messages: out.messages,
						unsupportedSeeds: out.unsupportedSeeds,
						tools: testCase.tools,
					});
				}
			}
		} finally {
			await m.close();
		}
	}
	return options.only
		? jobs.filter((job) =>
				options.only!({
					arm: job.arm.id,
					caseId: job.caseId,
					trial: job.trial,
				}),
			)
		: jobs;
}

export async function executeRun(
	options: RunOptions,
): Promise<{ jobs: number }> {
	const clock = options.clock ?? (() => performance.now());
	const jobs = await planJobs(options);
	const run = async (job: Job) => {
		const serialized = JSON.stringify(
			job.messages.map((m) => [m.role, m.content]),
		);
		const bytes = Buffer.byteLength(serialized, "utf8");
		const base = {
			lane: options.lane,
			arm: job.arm.id,
			caseId: job.caseId,
			trial: job.trial,
			startedAt: new Date().toISOString(),
			messageCount: job.messages.length,
			promptBytes: bytes,
			promptTokensEstimate: estimateTokens(bytes),
			promptSha256: sha(serialized),
			unsupportedSeeds: job.unsupportedSeeds,
		};
		const started = clock();
		try {
			const outcome = await options.runner(
				{
					caseId: job.caseId,
					arm: job.arm.id,
					trial: job.trial,
					messages: job.messages,
					tools: job.tools,
				},
				AbortSignal.timeout(options.timeoutMs ?? 120_000),
			);
			const latencyMs = Math.max(0, clock() - started);
			options.onRow(
				outcome.kind === "ok"
					? {
							...base,
							status: "ok",
							answer: { text: outcome.text, toolCalls: outcome.toolCalls },
							repaired: outcome.repaired,
							latencyMs,
						}
					: {
							...base,
							status: "contract_failure",
							errorCode: outcome.code,
							repaired: outcome.repaired,
							latencyMs,
						},
			);
		} catch (error) {
			options.onRow({
				...base,
				status: "transport_error",
				// The class of the failure only: provider text may carry user content.
				errorCode: error instanceof Error ? error.name : "unknown",
				repaired: false,
				latencyMs: Math.max(0, clock() - started),
			});
		}
	};
	let next = 0;
	const workers = Array.from(
		{
			length: Math.min(
				Math.max(1, Math.min(2, options.concurrency)),
				jobs.length,
			),
		},
		async () => {
			while (next < jobs.length) await run(jobs[next++]!);
		},
	);
	await Promise.all(workers);
	return { jobs: jobs.length };
}
