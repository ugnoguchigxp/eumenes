import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "../../domains/claude-code";
import { claudeRunnerClient } from "../../domains/coding";
import type { DevelopmentSupervisionService } from "../../domains/development-supervision";
import { createGoalsService } from "../../domains/goals";
import type { ArchivePort } from "../../domains/markdown";
import { createTerminals } from "../../domains/terminals";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";
import { configureDevelopmentSupervision } from "./development-supervision-host";
import { createKanbanExecutorRegistry } from "./kanban-executors";
import { createKanbanAdapter } from "./kanban-adapter";
import { extendKanbanAdapter } from "./kanban-shared-adapter";
import { supervisionOperation } from "./supervision-board";
import type { Messages } from "../../domains/inference/contracts";

export const verifyRequest = "集計の固定試験を実行して結果を確認してください。";
export const readRequest =
	"入力の欠落条件を静的に調べ、その後に再現試験を実行してください。";
export const failureRequest =
	"集計の固定試験を実行し、独立に入力の欠落条件を静的に調べてください。失敗した試験は入力を直した後に再実行します。";
export const failureReason =
	"固定試験の不合格を確認しました。入力の修正待ちです。";
export const aggregateTitle = "集計の固定試験";
export const inputTitle = "欠落条件の調査と再現";
export const otherRequest = "別の話です。短く挨拶してください。";
export const otherAnswer = "こんにちは。会話を続けられます。";
export const fixtureToken = "fixture-token-for-toolchain-browser";

export type StartObservation = {
	id: string;
	workId: string;
	mode: "read" | "verify" | "edit";
	at: number;
};
export type ParallelSnapshot = {
	rows: ReturnType<DevelopmentSupervisionService["boardRowsInTransaction"]>;
	parents: NonNullable<
		ReturnType<DevelopmentSupervisionService["progressInTransaction"]>
	>[];
	board: {
		supervisedRows: {
			taskId: string;
			parentRevision: number;
			revision: number;
			reason: string;
			state: string;
			outcome?: string;
		}[];
	} | null;
	previews: { id: string; markdown: string }[];
};

const localArchive: ArchivePort = {
	available: () => false,
	binding: () => "isolated-supervision-parallel",
	capabilities: async () => {
		throw new Error("fixture_archive_not_expected");
	},
	list: async () => ({ items: [], namespaces: [], nextCursor: null }),
	read: async () => {
		throw new Error("fixture_archive_not_expected");
	},
	save: async () => {
		throw new Error("fixture_archive_not_expected");
	},
};

function proposals(root: string, request: string) {
	const read = request === readRequest;
	const verification = {
		mode: "verify" as const,
		instruction:
			"Run just the approved verification. Use its exact approved Bash command, including the cwd and shell quoting supplied by the runner. Do not start a background task. Report the result and stop.",
		acceptance: [
			read
				? "The reproduction demonstrates which inputs are omitted."
				: "The aggregate check counts both rows.",
		],
		authorityQuote: request,
		readablePaths: read
			? ["input.ts", "input.test.ts"]
			: ["aggregate.ts", "aggregate.test.ts"],
		writablePaths: [],
		checks: [
			{
				executable: process.execPath,
				cwd: root,
				args: ["test", read ? "input.test.ts" : "aggregate.test.ts"],
			},
		],
	};
	if (!read)
		return [
			{
				...verification,
				title: aggregateTitle,
				after: null,
				verification: null,
			},
		];
	return [
		{
			...verification,
			title: inputTitle,
			after: null,
			mode: "read",
			checks: [],
			verification,
			instruction: `Use Read on the absolute file ${join(root, "input.ts")}. Then state the exact condition that excludes a row and stop. Read only, do not run any commands.`,
			acceptance: ["Identify the empty-input filter from source evidence."],
		},
	];
}

function structured(root: string, messages: Messages): unknown {
	const system = messages[0]?.content ?? "";
	if (system.includes("あなたは依頼の設計担当です")) {
		const read = messages.some(({ content }) => content.includes(readRequest));
		return {
			status: "ready",
			title: read ? inputTitle : aggregateTitle,
			summary: "試験用リポジトリの設計",
			sources: [],
			missing: null,
			markdown: read
				? "# 入力処理\ninput.ts の条件を読み、input.test.ts の固定入力で再現する。"
				: "# 集計処理\naggregate.test.ts の固定入力で2件を確認する。",
		};
	}
	let data;
	try {
		data = JSON.parse(messages.at(-1)!.content);
	} catch {
		return;
	}
	const failureTrial = data.originalRequest === failureRequest;
	if (data.researchRemaining !== undefined) {
		const proposed = proposals(root, data.originalRequest);
		return {
			decision: {
				action: "design",
				mode: "execute",
				title: "固定入力の検証",
				analysis: "試験用の既存関数と固定入力の試験を照合する。",
				guideQuery: "固定入力の試験",
				proposals:
					failureTrial && !data.replanTaskId
						? [
								...proposed,
								{ ...proposals(root, readRequest)[0]!, verification: null },
							]
						: proposed,
			},
		};
	}
	if (data.executionsLeft !== undefined) {
		const observation = data.observation;
		if (observation?.state === "running")
			return {
				decision: {
					action: "wait",
					summary: "認証済みClaudeが実行中",
					memo: "",
				},
			};
		if (observation?.state === "failed")
			return {
				decision: {
					action: "finish",
					status: "failed",
					summary: "Claude の実行が失敗しました。",
					memo: "",
					fulfilled: [],
					missing: ["実行の完了"],
					refs: [],
				},
			};
		if (observation?.state === "finished")
			return {
				decision: {
					action: "finish",
					status: "completed",
					summary: "実行と証跡を確認しました。",
					memo: "",
					fulfilled: ["確認を実行"],
					missing: [],
					refs: observation.evidence
						.map(({ ref }: { ref: string }) => ref)
						.slice(-8),
				},
			};
		return {
			decision: {
				action: "invoke",
				summary: "許可済みの操作を実行します。",
				memo: "",
				instruction: data.request,
			},
		};
	}
	if (data.child) {
		const read = data.task.mode === "read";
		const proof = data.child.evidence.find(
			(candidate: { kind: string; passed?: boolean }) =>
				read
					? candidate.kind === "read"
					: candidate.kind === "check" && candidate.passed === true,
		);
		if (failureTrial && !read && !proof) {
			const failed = data.child.evidence.find(
				(candidate: { kind: string; passed?: boolean }) =>
					candidate.kind === "check" && candidate.passed === false,
			);
			if (failed)
				return {
					decision: {
						action: "replan",
						reason: failureReason,
						refs: [failed.ref],
					},
				};
		}
		return {
			decision: proof
				? {
						action: read && !failureTrial ? "verify" : "accept",
						reason: read
							? "入力の欠落条件を読み取りました。"
							: "固定入力の試験が成功しました。",
						refs: [proof.ref],
					}
				: {
						action: "finish",
						reason: "固定入力の試験に必要な証跡を得られませんでした。",
						status: "failed",
					},
		};
	}
	if (Array.isArray(data.amendments)) return { decision: { mode: "verify" } };
}

async function launch(
	root: string,
	directory: string,
	socket: string,
	ready: string,
	journal: string,
	access: string,
	readGate?: string,
) {
	const client = claudeRunnerClient(socket, root);
	if (!(await client.probe()) || !client.supportsSupervised())
		throw new Error("parallel_runner_unavailable");
	const runner: Runner = {
		...client,
		start: async (spec) => {
			const supervised = spec.supervised;
			if (!supervised) throw new Error("unexpected_direct_claude_start");
			appendFileSync(
				journal,
				JSON.stringify({
					id: spec.id,
					workId: spec.workId,
					mode: supervised.authorization.mode,
					at: Date.now(),
				} satisfies StartObservation) + "\n",
			);
			return client.start(spec);
		},
	};
	if (readGate) {
		const approve = runner.approveTool!;
		const start = runner.start;
		const readExecutions = new Set<string>();
		runner.start = (spec) => {
			if (spec.supervised?.authorization.mode === "read")
				readExecutions.add(spec.id);
			return start(spec);
		};
		runner.approveTool = async (id, requestId, lease) => {
			if (!readExecutions.has(id) || existsSync(readGate))
				await approve(id, requestId, lease);
		};
	}
	const h = await harness({
		directory,
		claudeRunner: runner,
		markdown: localArchive,
		memory: true,
		webNote: {},
		kanban: true,
		terminals: (store) =>
			createTerminals({
				store,
				command: ["fixture"],
				spawn: () => {
					throw new Error("unexpected_manual_terminal");
				},
			}),
		discoveryTarget: () => "development_supervision",
		firstRound: (_tools, request, messages) =>
			request === otherRequest
				? { text: otherAnswer }
				: searchThenDelegate(
						(card) => card.id === "development-supervision.request",
						request,
						{ impact: "none", announcement: "開発作業を進めます。" },
					)(messages),
		structuredResponse: (messages) => structured(root, messages),
	});
	const supervisor = h.toolchain.developmentSupervision;
	const admitted = new Set<string>();
	const admit = supervisor.task.startInTransaction;
	supervisor.task.startInTransaction = (db, input) => {
		const accepted = admit(db, input);
		admitted.add(accepted.id);
		return accepted;
	};
	if (readGate) {
		const child = h.toolchain.claudeCode.supervised;
		const read = child.viewInTransaction;
		const observed = new Map<string, string>();
		child.viewInTransaction = (db, source, id) => {
			const current = read(db, source, id);
			if (!current) return current;
			const line = JSON.stringify({
				id,
				revision: current.view.revision,
				status: current.view.status,
				executionId: current.executionId,
				released: current.releaseConfirmed,
				proof: current.evidence.map(({ ref, passed }) => ({ ref, passed })),
			});
			if (observed.get(id) !== line) {
				observed.set(id, line);
				appendFileSync(journal + ".child", line + "\n");
			}
			return current;
		};
		const execute = h.inference.executeControl!;
		h.inference.executeControl = async (...args) => {
			const [, messages, signal] = args;
			if (
				messages[0]?.content.includes(
					"Choose the next action for this development request",
				)
			) {
				const data = JSON.parse(messages.at(-1)!.content);
				if (data.originalRequest === failureRequest && data.replanTaskId) {
					while (!existsSync(readGate + ".replan")) {
						signal?.throwIfAborted();
						await Bun.sleep(50);
					}
				}
			}
			return execute(...args);
		};
	}
	await h.store.write((db) =>
		h.toolchain.capabilities.publishToolchainRevisionInTransaction(
			db,
			"claude-code.request",
			"toolchain:claude-code.request@7",
		),
	);
	configureDevelopmentSupervision({
		supervisor,
		store: h.store,
		inference: h.inference,
		execution: h.executionPort!,
		capabilities: h.toolchain.capabilities,
		note: h.toolchain.webNote,
		claude: h.toolchain.claudeCode,
		checkout: root,
		markdown: h.markdown!,
		dialogue: h.dialogue,
		context: { memory: h.memory!, goals: createGoalsService() },
		knowledge: {
			selectForSupervision: async () => [],
			supervisionSkillCurrentInTransaction: () => false,
		},
	});
	const board = extendKanbanAdapter(
		createKanbanAdapter(h.kanban!, { runnable: () => false }),
		{
			kanban: h.kanban!,
			registry: createKanbanExecutorRegistry([]),
			supervision: () => supervisor,
		},
	);
	h.toolchain.claudeCode.start();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path !== "/test-observation" && path !== "/test-supervised-amend")
				return h.app.fetch(request);
			if (request.headers.get("x-supervision-test") !== access)
				return new Response(null, { status: 404 });
			if (path === "/test-supervised-amend") {
				const input = await request.json();
				const requestId = crypto.randomUUID();
				return Response.json(
					await h.store.write((db) =>
						board.invokeInTransaction(db, {
							operationName: supervisionOperation,
							input,
							requestId,
							issuedAt: new Date().toISOString(),
							origin: {
								kind: "ui",
								scope: "isolated-supervision",
								actionRequestId: requestId,
							},
						}),
					),
				);
			}
			await supervisor.recover();
			return Response.json(
				h.store.readSnapshot((db): ParallelSnapshot => {
					const rows = supervisor.boardRowsInTransaction(db, {
						conversationId: "development",
					});
					const parents = [
						...new Set([...admitted, ...rows.map(({ parentId }) => parentId)]),
					].flatMap((id) => supervisor.progressInTransaction(db, id) ?? []);
					const previews = parents.flatMap(({ designs }) =>
						designs
							.filter(({ uri }) => uri)
							.flatMap(({ documentId: id }) => {
								const preview = h.markdown!.generated.localPreviewInTransaction(
									db,
									id,
								);
								return preview ? [{ id, markdown: preview.markdown }] : [];
							}),
					);
					return {
						rows,
						parents,
						previews,
						board:
							(board.sourceInTransaction(db, "query:kanban.board@3", undefined)
								?.data as ParallelSnapshot["board"]) ?? null,
					};
				}),
			);
		},
	});
	let closing = false;
	process.on("SIGTERM", async () => {
		if (closing) return;
		closing = true;
		await server.stop(true);
		await h.close();
		process.exit(0);
	});
	writeFileSync(ready, String(server.port), { mode: 0o600 });
}

if (import.meta.main) {
	const [root, directory, socket, ready, journal, access, readGate] =
		process.argv.slice(2);
	if (!root || !directory || !socket || !ready || !journal || !access)
		throw new Error("isolated_fixture_arguments_required");
	if (join(directory, "..", "checkout") !== root)
		throw new Error("isolated_fixture_checkout_required");
	await launch(root, directory, socket, ready, journal, access, readGate);
}
