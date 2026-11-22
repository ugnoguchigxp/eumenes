import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	closeSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRunnerClient } from "../../domains/coding";
import { conversationSchema } from "../../domains/conversation/contracts";
import { runSchema, todoNoticesSchema } from "../../domains/dialogue/contracts";
import { sha256Hex } from "../../infrastructure/digest";
import {
	aggregateTitle,
	failureReason,
	failureRequest,
	fixtureToken,
	inputTitle,
	otherAnswer,
	otherRequest,
	readRequest,
	verifyRequest,
	type ParallelSnapshot,
	type StartObservation,
} from "./supervision-parallel-backend.fixture";
import { serveSupervisionTrialRunner } from "./supervision-parallel-runner.fixture";

const launched = process.env.EUMENES_SUPERVISION_PARALLEL_LIVE === "1";
const failureLaunched = process.env.EUMENES_SUPERVISION_FAILURE_LIVE === "1";
const monitoringMs = 80_000;

function seed(root: string, release: string) {
	mkdirSync(root);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
	git("init", "-q");
	writeFileSync(
		join(root, "aggregate.ts"),
		"export const countRows = (rows: number[]) => rows.length;\n",
	);
	writeFileSync(
		join(root, "aggregate.test.ts"),
		`import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { countRows } from './aggregate';
test('count all rows after the gate is released', async () => {
  expect(countRows([2, 5])).toBe(2);
  writeFileSync(join(process.env.TMPDIR!, 'aggregate-started'), String(Date.now()));
  const release = ${JSON.stringify(release)};
  while (!existsSync(release)) await Bun.sleep(100);
}, 240_000);
`,
	);
	writeFileSync(
		join(root, "input.ts"),
		`export const nonempty = (rows: string[]) => rows.filter((value) => value.trim().length > 0);\n`,
	);
	writeFileSync(
		join(root, "input.test.ts"),
		`import { expect, test } from 'bun:test';
import { nonempty } from './input';
test('only whitespace-only rows are omitted', () => expect(nonempty(['x','   ','y',''])).toEqual(['x','y']));
`,
	);
	git("add", ".");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@localhost",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"fixed inputs",
	);
}

async function until<T>(
	label: string,
	check: () => T | null | false | Promise<T | null | false>,
	timeout = monitoringMs,
): Promise<T> {
	const deadline = Date.now() + timeout;
	do {
		const value = await check();
		if (value) return value;
		await Bun.sleep(100);
	} while (Date.now() < deadline);
	throw new Error(`parallel acceptance stopped at ${label}`);
}

function startsAt(path: string): StartObservation[] {
	if (!existsSync(path)) return [];
	const records = readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((row) => JSON.parse(row) as StartObservation);
	return [...new Map(records.map((entry) => [entry.id, entry])).values()];
}

function actualStart(id: string) {
	const prefix = `claude-check-${id}-`;
	const directory = readdirSync(tmpdir()).find((entry) =>
		entry.startsWith(prefix),
	);
	if (!directory) return null;
	const marker = join(tmpdir(), directory, "files", "aggregate-started");
	return existsSync(marker) ? Number(readFileSync(marker, "utf8")) : null;
}

async function backend(
	root: string,
	directory: string,
	journal: string,
	socket: string,
	readGate?: string,
) {
	const ready = join(directory, `ready-${crypto.randomUUID()}`);
	const log = `${ready}.log`;
	const access = crypto.randomUUID();
	const out = openSync(log, "w", 0o600);
	const proc = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "supervision-parallel-backend.fixture.ts"),
			root,
			directory,
			socket,
			ready,
			journal,
			access,
			...(readGate ? [readGate] : []),
		],
		{ stdin: "ignore", stdout: out, stderr: out },
	);
	closeSync(out);
	function excerpt() {
		return readFileSync(log, "utf8").split("\n").slice(-8).join("\n");
	}
	const port = await until(
		"専用backendの起動",
		() => {
			if (proc.exitCode !== null)
				throw new Error(`isolated_backend_exit:${proc.exitCode}\n${excerpt()}`);
			return existsSync(ready) ? Number(readFileSync(ready, "utf8")) : null;
		},
		15_000,
	).catch(async (error) => {
		proc.kill("SIGKILL");
		await proc.exited;
		throw error;
	});
	async function request(path: string, body?: unknown) {
		const result = await fetch(`http://127.0.0.1:${port}${path}`, {
			method: body ? "POST" : "GET",
			headers: {
				authorization: `Bearer ${fixtureToken}`,
				"x-supervision-test": access,
				...(body ? { "content-type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(6_000),
		});
		if (!result.ok)
			throw new Error(`isolated_backend_http_${result.status}:${path}`);
		return result.json();
	}
	return {
		pid: proc.pid,
		request,
		excerpt,
		snapshot: async () =>
			(await request("/test-observation")) as ParallelSnapshot,
		async close() {
			if (proc.exitCode !== null) return;
			proc.kill("SIGTERM");
			const timer = setTimeout(() => {
				if (proc.exitCode === null) proc.kill("SIGKILL");
			}, 8_000);
			const code = await proc.exited;
			clearTimeout(timer);
			if (code !== 0)
				throw new Error(`isolated_backend_close:${code}\n${excerpt()}`);
		},
	};
}

const order = (time: number | null, next: number) => {
	expect(time).not.toBeNull();
	expect(time!).toBeLessThanOrEqual(next);
};

test.skipIf(!launched)(
	"real Claude read overlaps a held verify, reopens durable backend and starts a new verify exactly once",
	async () => {
		const directory = realpathSync(mkdtempSync("/tmp/eum-parallel-"));
		const root = join(directory, "checkout");
		const release = join(directory, "release-aggregate");
		const database = join(directory, "database");
		const journal = join(directory, "starts.jsonl");
		mkdirSync(database, { mode: 0o700 });
		seed(root, release);
		let active: Awaited<ReturnType<typeof backend>> | undefined;
		const runner = await serveSupervisionTrialRunner(
			join(directory, "claude"),
			root,
		);
		const inspect = claudeRunnerClient(runner.socket, root);
		let checkpoint = "backend startup";
		let readRunId: string | undefined;
		try {
			expect(await inspect.probe()).toBe(true);
			active = await backend(root, database, journal, runner.socket);
			const submit = async (text: string, conversationId: string) =>
				runSchema.parse(
					await active!.request("/api/runs", {
						requestId: crypto.randomUUID(),
						conversationId,
						text,
					}),
				);
			checkpoint = "aggregate start";
			await submit(verifyRequest, "development");
			const aggregate = await until(
				"集計の実行ID",
				() => startsAt(journal).find(({ mode }) => mode === "verify") ?? null,
			);
			const aggregateStarted = await until("集計の実試験開始", async () => {
				const at = actualStart(aggregate.id);
				if (at) return at;
				const view = await inspect.inspect(aggregate.id);
				if (view?.managedExecutionStopped)
					throw new Error(`aggregate_ended_before_test:${view.state}`);
				return null;
			});
			checkpoint = "parallel read";
			readRunId = (await submit(readRequest, "development")).id;
			const readIntake = await until("静的読解の会話run終端", async () => {
				const run = runSchema.parse(
					await active!.request(`/api/runs/${readRunId}`),
				);
				return run.status === "queued" || run.status === "running" ? null : run;
			});
			expect(readIntake.status).toBe("completed");
			const admitted = await active.snapshot();
			expect(admitted.parents).toHaveLength(2);
			const reading = await until(
				"静的読解の実行ID",
				() => startsAt(journal).find(({ mode }) => mode === "read") ?? null,
			);
			const proof = await until(
				"静的読解の実証跡",
				async () =>
					(await inspect.inspect(reading.id))?.structuredEvidence?.find(
						({ kind, path }) =>
							kind === "read" && path === join(root, "input.ts"),
					) ?? null,
			);
			const readObserved = Date.now();
			expect((await inspect.inspect(aggregate.id))?.state).toBe("running");
			checkpoint = "edit slot wait while chat works";
			const held = await until("読取り完了後の編集枠待ち", async () => {
				const view = await active!.snapshot();
				return view.rows.some(
					({ title, reason }) =>
						title === inputTitle && reason === "編集枠待ち",
				)
					? view
					: null;
			});
			expect(startsAt(journal)).toHaveLength(2);
			expect(
				held.rows.find(({ title }) => title === aggregateTitle)?.state,
			).toBe("running");
			const task = held.rows.find(({ title }) => title === inputTitle)!;
			expect(task.evidenceRefs).toContain(proof.ref);
			const aside = await submit(otherRequest, "development");
			await until(
				"別の話題への応答",
				async () =>
					runSchema.parse(await active!.request(`/api/runs/${aside.id}`))
						.status === "completed",
			);
			const conversation = conversationSchema.parse(
				await active.request("/api/conversations/development"),
			);
			expect(
				conversation.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.runId === aside.id &&
						message.text === otherAnswer,
				),
			).toBe(true);
			const separate = await submit(otherRequest, "another-conversation");
			await until(
				"別会話の応答",
				async () =>
					runSchema.parse(await active!.request(`/api/runs/${separate.id}`))
						.status === "completed",
			);
			checkpoint = "restart with durable design and read evidence";
			const oldPid = active.pid;
			await active.close();
			active = await backend(root, database, journal, runner.socket);
			expect(active.pid).not.toBe(oldPid);
			const reopened = await active.snapshot();
			expect(reopened.parents).toHaveLength(2);
			expect(reopened.previews).toHaveLength(2);
			for (const parent of reopened.parents) {
				const design = parent.designs[0]!;
				const body = reopened.previews.find(
					({ id }) => id === design.documentId,
				)!;
				expect(design.digest).toBe(sha256Hex(body.markdown));
				expect(design.uri).toBeTruthy();
			}
			expect(
				reopened.rows.find(({ taskId }) => taskId === task.taskId)
					?.evidenceRefs,
			).toContain(proof.ref);
			expect(
				reopened.board?.supervisedRows.find(
					({ taskId }) => taskId === task.taskId,
				)?.reason,
			).toBe("編集枠待ち");
			expect((await inspect.inspect(aggregate.id))?.state).toBe("running");
			const releasedAt = Date.now();
			writeFileSync(release, "released\n");
			checkpoint = "verification after confirmed release";
			const reproduced = await until(
				"読解とは別の再現実行ID",
				() =>
					startsAt(journal).find(
						({ id, mode }) => id !== aggregate.id && mode === "verify",
					) ?? null,
			);
			expect(reproduced.workId).not.toBe(reading.workId);
			const aggregateEnd = await until("集計の停止と合格証跡", async () => {
				const view = await inspect.inspect(aggregate.id);
				return view?.managedExecutionStopped &&
					view.structuredEvidence?.some(
						({ kind, passed }) => kind === "check" && passed,
					)
					? view
					: null;
			});
			const completed = await until("両タスクの受入", async () => {
				const view = await active!.snapshot();
				return view.rows.length === 2 &&
					view.rows.every(
						(row) => row.state === "finished" && row.outcome === "succeeded",
					)
					? view
					: null;
			});
			const reproduction = await inspect.inspect(reproduced.id);
			expect(
				reproduction?.structuredEvidence?.some(
					({ kind, passed }) => kind === "check" && passed,
				),
			).toBe(true);
			expect(
				completed.rows.find(({ title }) => title === inputTitle),
			).toMatchObject({ taskId: task.taskId, outcome: "succeeded" });
			expect(
				completed.board?.supervisedRows.map(({ outcome }) => outcome),
			).toEqual(["succeeded", "succeeded"]);
			expect(startsAt(journal)).toHaveLength(3);
			order(aggregateStarted, reading.at);
			order(readObserved, releasedAt);
			order(releasedAt, reproduced.at);
			console.info(
				JSON.stringify({
					aggregate: {
						executionId: aggregate.id,
						startedAt: aggregateStarted,
						finalSequence: aggregateEnd.seq,
					},
					reading: { executionId: reading.id, proofObservedAt: readObserved },
					releasedAt,
					reproduction: {
						executionId: reproduced.id,
						requestedAt: reproduced.at,
					},
					backendPids: [oldPid, active.pid],
				}),
			);
		} catch (error) {
			const starts = startsAt(journal);
			const states = await Promise.all(
				starts.map(async ({ id, mode }) => {
					const view = await inspect.inspect(id).catch(() => null);
					return {
						id,
						mode,
						state: view?.state,
						seq: view?.seq,
						blocked: view?.blocked,
						evidence: view?.structuredEvidence?.map(({ kind, passed }) => ({
							kind,
							passed,
						})),
					};
				}),
			);
			const snapshot = await active?.snapshot().catch(() => null);
			const readRun = readRunId
				? await active
						?.request(`/api/runs/${readRunId}`)
						.then((value) => runSchema.parse(value))
						.catch(() => null)
				: undefined;
			console.error(
				JSON.stringify({
					checkpoint,
					states,
					readRun: readRun && {
						id: readRun.id,
						status: readRun.status,
						error: readRun.error,
					},
					parents: snapshot?.parents.map(({ parentId, state, reason }) => ({
						parentId,
						state,
						reason,
					})),
					rows: snapshot?.rows.map(({ title, state, reason }) => ({
						title,
						state,
						reason,
					})),
				}),
			);
			throw error;
		} finally {
			try {
				writeFileSync(release, "cleanup\n");
				await active?.close();
			} finally {
				await runner.close();
				rmSync(directory, { recursive: true, force: true });
			}
		}
	},
	300_000,
);

test.skipIf(!failureLaunched)(
	"real Claude failing verification leaves its sibling independent and succeeds on fresh evidence only",
	async () => {
		const directory = realpathSync(mkdtempSync("/tmp/eum-failure-"));
		const root = join(directory, "checkout");
		const release = join(directory, "release-aggregate");
		const readGate = join(directory, "allow-read");
		const database = join(directory, "database");
		const journal = join(directory, "starts.jsonl");
		mkdirSync(database, { mode: 0o700 });
		seed(root, release);
		const aggregateFile = join(root, "aggregate.ts");
		const corrected = readFileSync(aggregateFile, "utf8");
		writeFileSync(
			aggregateFile,
			"export const countRows = (_rows: number[]) => 0;\n",
		);
		const runner = await serveSupervisionTrialRunner(
			join(directory, "claude"),
			root,
		);
		const inspect = claudeRunnerClient(runner.socket, root);
		let active: Awaited<ReturnType<typeof backend>> | undefined;
		let checkpoint = "backend startup";
		try {
			expect(await inspect.probe()).toBe(true);
			active = await backend(root, database, journal, runner.socket, readGate);
			await active.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "development",
				text: failureRequest,
			});
			const notices = async () =>
				todoNoticesSchema.parse(await active!.request("/api/todo-notices"))
					.notices;
			const compare = (snapshot: ParallelSnapshot, title: string) => {
				expect(snapshot.parents).toHaveLength(1);
				const fromConversation = snapshot.parents[0]!.tasks.find(
					(row) => row.title === title,
				)!;
				const fromBoard = snapshot.board?.supervisedRows.find(
					(row) => row.taskId === fromConversation.taskId,
				);
				expect(fromBoard).toMatchObject({
					taskId: fromConversation.taskId,
					parentRevision: fromConversation.parentRevision,
					revision: fromConversation.revision,
					state: fromConversation.state,
					reason: fromConversation.reason,
					...(fromConversation.state === "finished"
						? { outcome: fromConversation.outcome }
						: {}),
				});
				return fromConversation;
			};
			checkpoint = "real failed check and its confirmed stop";
			const failed = await until("集計の不合格と停止", async () => {
				const start = startsAt(journal).find(({ mode }) => mode === "verify");
				if (!start) return null;
				const receipt = await inspect.inspect(start.id);
				const proof = receipt?.structuredEvidence?.find(
					({ kind, passed }) => kind === "check" && passed === false,
				);
				return receipt?.managedExecutionStopped && proof
					? { start, proof }
					: null;
			});
			const stoppedAt = Date.now();
			const waiting = await until("会話とボードの再計画中の表示", async () => {
				const snapshot = await active!.snapshot();
				const aggregate = snapshot.parents[0]?.tasks.find(
					({ title }) => title === aggregateTitle,
				);
				if (aggregate?.state === "finished")
					throw new Error(`verify_finished_before_replan:${aggregate.reason}`);
				return snapshot.parents[0]?.tasks.some(
					(row) =>
						row.title === aggregateTitle &&
						row.reason.includes(failureReason) &&
						row.state === "held",
				)
					? snapshot
					: null;
			});
			const original = compare(waiting, aggregateTitle);
			expect(waiting.parents[0]!.result).toBeNull();
			expect(
				waiting.parents[0]!.tasks.find(({ title }) => title === inputTitle)
					?.state,
			).not.toBe("finished");
			const earlySuccesses = (await notices()).filter(
				({ outcome }) => outcome === "succeeded",
			).length;
			expect(earlySuccesses).toBe(0);

			checkpoint = "independent read and no unchanged retry";
			writeFileSync(readGate, "independent read may continue\n");
			const reading = await until("独立した静的読解と停止", async () => {
				const start = startsAt(journal).find(({ mode }) => mode === "read");
				const receipt = start && (await inspect.inspect(start.id));
				return start &&
					receipt?.managedExecutionStopped &&
					receipt.structuredEvidence?.some(({ kind }) => kind === "read")
					? start
					: null;
			});
			const read = await active.snapshot();
			expect(compare(read, aggregateTitle).reason).toContain(failureReason);
			expect(read.parents[0]!.result).toBeNull();
			expect(startsAt(journal)).toHaveLength(2);
			expect(
				(await notices()).filter(({ outcome }) => outcome === "succeeded"),
			).toEqual([]);

			checkpoint =
				"retry only after the fixture input and authorized condition change";
			writeFileSync(aggregateFile, corrected);
			await active.request("/test-supervised-amend", {
				parentId: original.parentId,
				taskId: original.taskId,
				action: "amend",
				expectedRevision: compare(read, aggregateTitle).revision,
				request:
					"集計の入力条件を修正しました。同じ固定試験をもう一度実行してください。",
			});
			writeFileSync(
				readGate + ".replan",
				"changed conditions are authorized\n",
			);
			const retried = await until(
				"修正後の新しい子実行",
				() =>
					startsAt(journal).find(
						({ mode, id }) => mode === "verify" && id !== failed.start.id,
					) ?? null,
			);
			expect(retried.workId).not.toBe(failed.start.workId);
			const independentlyAccepted = await until(
				"再試験の合格前に静的読解が受け入れられる",
				async () => {
					const snapshot = await active!.snapshot();
					return snapshot.parents[0]?.tasks.some(
						(row) =>
							row.title === inputTitle &&
							row.state === "finished" &&
							row.outcome === "succeeded",
					)
						? snapshot
						: null;
				},
			);
			expect(compare(independentlyAccepted, inputTitle)).toMatchObject({
				outcome: "succeeded",
			});
			expect(independentlyAccepted.parents[0]?.result).toBeNull();
			expect(
				(await notices()).filter(({ outcome }) => outcome === "succeeded"),
			).toEqual([]);
			writeFileSync(release, "corrected fixture is ready\n");
			const passed = await until("修正後の合格証跡", async () => {
				const receipt = await inspect.inspect(retried.id);
				const proof = receipt?.structuredEvidence?.find(
					({ kind, passed }) => kind === "check" && passed === true,
				);
				return receipt?.managedExecutionStopped && proof ? proof : null;
			});
			expect(passed.inputDigest).not.toBe(failed.proof.inputDigest);
			const finished = await until("同一の監督タスクと親の成功", async () => {
				const snapshot = await active!.snapshot();
				return snapshot.parents[0]?.result?.status === "completed"
					? snapshot
					: null;
			});
			expect(compare(finished, aggregateTitle)).toMatchObject({
				taskId: original.taskId,
				outcome: "succeeded",
				evidenceRefs: [passed.ref],
			});
			expect(compare(finished, inputTitle)).toMatchObject({
				outcome: "succeeded",
			});
			expect(finished.parents[0]?.result?.refs).toContain(passed.ref);
			expect(finished.parents[0]?.result?.refs).not.toContain(failed.proof.ref);
			expect(startsAt(journal)).toHaveLength(3);
			const finalNotices = await until("親成功通知", async () => {
				const current = (await notices()).filter(
					({ outcome }) => outcome === "succeeded",
				);
				return current.length ? current : null;
			});
			expect(finalNotices).toHaveLength(1);
			console.info(
				JSON.stringify({
					failedExecution: failed.start.id,
					failureProof: failed.proof.ref,
					stoppedAt,
					readingExecution: reading.id,
					readOutcome: "succeeded",
					retryExecution: retried.id,
					acceptedProof: passed.ref,
					taskId: original.taskId,
					failedRowsMatched: true,
					earlySuccesses,
					finalSuccesses: finalNotices.length,
				}),
			);
		} catch (error) {
			console.error(
				JSON.stringify({
					checkpoint,
					starts: startsAt(journal),
					childViews: existsSync(journal + ".child")
						? readFileSync(journal + ".child", "utf8")
								.trim()
								.split("\n")
								.map((line) => JSON.parse(line))
						: [],
					rows: (await active?.snapshot().catch(() => null))?.rows.map(
						({ title, state, reason }) => ({ title, state, reason }),
					),
				}),
			);
			throw error;
		} finally {
			try {
				writeFileSync(release, "cleanup\n");
				writeFileSync(readGate + ".replan", "cleanup\n");
				await active?.close();
			} finally {
				await runner.close();
				rmSync(directory, { recursive: true, force: true });
			}
		}
	},
	300_000,
);
