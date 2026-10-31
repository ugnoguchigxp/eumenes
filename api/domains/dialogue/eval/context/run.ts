/**
 * The run loop: materialize each case once (the production prepare on a fresh store), check the messages keep the
 * invariants, call the conversation runner once per trial with bounded concurrency, and emit one raw row per call.
 * No retries, no voting, no caching: a failed call is a row with status `transport_error`.
 */
import { createHash } from "node:crypto";
import { estimateMessageTokens } from "../../../inference";
import type { GenerateInput } from "../../service/context";
import type { ContextCase } from "./case-schema";
import type { EvalCard, Persona } from "./session";
import type { ConversationRunner } from "./generation-runner";
import { type SeedWiring, materialize } from "./materialize";
import { assertMessageInvariants } from "./message-invariants";
import { canonicalJson } from "./prefix-stability";
import type { Lane, RawRow } from "./raw";

type Job = {
	order: number;
	caseId: string;
	trial: number;
	input: GenerateInput;
	persona: Persona;
};

export type RunOptions = {
	lane: Lane;
	cases: readonly ContextCase[];
	trials: number;
	/** Clamped to 1..2. */
	concurrency: number;
	openWiring: () => Promise<SeedWiring>;
	/** The toolchains a search offers (and a seeded TODO names). */
	catalog: readonly EvalCard[];
	runner: ConversationRunner;
	onRow: (row: RawRow) => void;
	timeoutMs?: number;
	clock?: () => number;
	/** Run only the calls this accepts (a sanctioned re-run of transport errors). The order stays the full plan's. */
	only?: (call: { caseId: string; trial: number }) => boolean;
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The jobs in execution order. Every case is prepared by the production code once; its trials share the messages. */
export async function planJobs(
	options: Pick<
		RunOptions,
		"cases" | "trials" | "openWiring" | "catalog" | "only"
	>,
): Promise<Job[]> {
	const jobs: Job[] = [];
	let order = 0;
	for (const testCase of options.cases) {
		const m = await materialize(testCase, await options.openWiring(), {
			catalog: options.catalog,
		});
		try {
			// A case whose messages break an invariant stops the run before any call.
			assertMessageInvariants(m.input, testCase.id);
			for (let trial = 1; trial <= options.trials; trial++)
				jobs.push({
					order: order++,
					caseId: testCase.id,
					trial,
					input: m.input,
					persona: m.persona,
				});
		} finally {
			await m.close();
		}
	}
	return options.only
		? jobs.filter((job) =>
				options.only!({ caseId: job.caseId, trial: job.trial }),
			)
		: jobs;
}

export async function executeRun(
	options: RunOptions,
): Promise<{ jobs: number }> {
	const clock = options.clock ?? (() => performance.now());
	const jobs = await planJobs(options);
	const run = async (job: Job) => {
		const serialized = canonicalJson(
			job.input.messages.map((m) => [m.role, m.content]),
		);
		const base = {
			lane: options.lane,
			caseId: job.caseId,
			trial: job.trial,
			startedAt: new Date().toISOString(),
			messageCount: job.input.messages.length,
			promptBytes: Buffer.byteLength(serialized, "utf8"),
			promptTokensEstimate: estimateMessageTokens(job.input.messages),
			promptSha256: sha(serialized),
		};
		const started = clock();
		try {
			const outcome = await options.runner(
				{
					caseId: job.caseId,
					trial: job.trial,
					input: job.input,
					persona: job.persona,
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
							latencyMs,
						}
					: {
							...base,
							status: "contract_failure",
							errorCode: outcome.code,
							latencyMs,
						},
			);
		} catch (error) {
			options.onRow({
				...base,
				status: "transport_error",
				// The class of the failure only: provider text may carry user content.
				errorCode: error instanceof Error ? error.name : "unknown",
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
