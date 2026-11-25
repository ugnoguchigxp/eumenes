import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../../domains/claude-code";
import {
	claudeRunnerClient,
	claudeInputDigest,
	type ClaudeObservation,
} from "../../domains/coding";
import type {
	SupervisionEvidence,
	SupervisionNote,
} from "../../domains/development-supervision/contracts";
import { conversationSchema } from "../../domains/conversation/contracts";
import { createGoalsService } from "../../domains/goals";
import { fixture as markdownFixture } from "../../domains/markdown/test/workspace.fixture";
import { createTerminals } from "../../domains/terminals";
import {
	ask,
	assignmentAgenda,
	items,
	reportLine,
	until,
} from "../media/assignment.fixture";
import { configureDevelopmentSupervision } from "./development-supervision-host";

import { fixtureEditRunner } from "./supervision-edit-runner.fixture";
import { serveSupervisionTrialRunner } from "./supervision-parallel-runner.fixture";
import {
	checkSupervisionSharedContext,
	seedSupervisionSharedContext,
	sourceCitation,
	type SharedContextFixture,
} from "./supervision-shared-context.fixture";

const live = process.env.EUMENES_LIVE_SUPERVISION_EDIT === "1";
const utterance = "集計関数を修正し、固定入力の回帰試験を実行してください。";
const conclusion = "集計関数を修正し、固定入力で期待件数を確認しました。";
const design =
	"# 集計関数の修正\n\nsum.ts を修正し、regression.test.ts が成功すること。";
const editInstruction =
	"Run the exact approved Bash regression command before editing. Read sum.ts, use Edit to fix sum so that it counts the number of rows, then rerun the same approved regression command. Preserve all other files.";

test(
	"an edit is the agent's assignment, the conversation stays available, then the agent reports the verified outcome once",
	async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "eumenes-supervision-through-")),
		);
		const file = join(root, "sum.ts"),
			draft = join(root, "operator.txt");
		const observed = {
			facts: [] as NonNullable<ClaudeObservation["structuredEvidence"]>,
			instructions: [] as string[],
			turns: 0,
		};
		let shared: SharedContextFixture | undefined;
		let plannerNotes: SupervisionNote[] = [];
		let designerNotes: Pick<SupervisionNote, "evidence" | "text">[] = [];
		const refs = () =>
			observed.facts
				.filter((fact) => fact.kind === "edit" || fact.passed === true)
				.map((fact) => fact.ref);
		const record = (value: ClaudeObservation | null) => {
			if (value?.structuredEvidence?.length)
				observed.facts = value.structuredEvidence;
			if (value?.turns) observed.turns = value.turns;
			return value;
		};
		const checkGate = Promise.withResolvers<void>();
		let entered = false;
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
		git("init", "-q");
		writeFileSync(file, "export const sum = (_rows: number[]) => 0;\n");
		writeFileSync(
			join(root, "regression.test.ts"),
			'import { expect, test } from "bun:test"; import { sum } from "./sum"; test("counts both rows",()=>expect(sum([2,5])).toBe(2));\n',
		);
		writeFileSync(draft, "baseline\n");
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
			"seed",
		);
		writeFileSync(draft, "operator's existing change\n");
		const drafts = markdownFixture();
		const privateDirectory = live
			? realpathSync(mkdtempSync(join(tmpdir(), "ec-")))
			: undefined;
		const privateRunner = privateDirectory
			? await serveSupervisionTrialRunner(privateDirectory, root)
			: undefined;
		const target = privateRunner
			? claudeRunnerClient(privateRunner.socket, root)
			: fixtureEditRunner(file);
		const runner: Runner = {
			...target,
			async start(spec) {
				expect(spec.supervised?.authorization.writablePaths).toEqual([file]);
				observed.instructions.push(spec.instruction);
				entered = true;
				await checkGate.promise;
				const value = await target.start(spec);
				record(value);
				return value;
			},
			async inspect(id) {
				return record(await target.inspect(id));
			},
		};
		const startAt = performance.now();
		if (!(await runner.probe!()))
			throw new Error("supervision_edit_trial_runner_unavailable");
		const a = await assignmentAgenda({
			harness: {
				markdown: drafts.archive,
				memory: true,
				kanban: true,
				webNote: {},
				claudeRunner: runner,
				terminals: (store) =>
					createTerminals({
						store,
						command: ["fixture"],
						spawn: () => {
							throw Error("manual terminal started");
						},
					}),
				firstRound: (_tools, question) => {
					if (question.includes("別の話"))
						return { text: "会話を続けられます。" };
				},
				structuredResponse(messages) {
					const system = messages[0]?.content ?? "";
					let data;
					try {
						data = JSON.parse(messages.at(-1)!.content);
					} catch {
						return;
					}
					if (system.includes("あなたは依頼の設計担当です")) {
						designerNotes = (
							data.memory as Pick<SupervisionNote, "evidence" | "text">[]
						).concat(
							(
								data.notes as {
									evidence: SupervisionEvidence;
									markdown: string;
								}[]
							).map(({ evidence, markdown }) => ({ evidence, text: markdown })),
						);
						const sources = shared
							? designerNotes.map(({ evidence }) => evidence)
							: [];
						return {
							status: "ready",
							title: "集計関数",
							summary: "件数の回帰試験",
							markdown: sources.length
								? `${design}\n\n## 出典\n${sources.map((evidence) => `- ${sourceCitation(evidence)}`).join("\n")}`
								: design,
							sources: sources.map(
								({ kind, id }) =>
									`${kind === "memory" ? "memory" : "note"}:${id}`,
							),
							missing: null,
						};
					}
					if (data.researchRemaining !== undefined) {
						plannerNotes = data.context;
						return {
							decision: {
								action: "design",
								title: "集計の修正",
								analysis: "件数を返す関数とテストを照合する",
								mode: "execute",
								guideQuery: "集計関数の回帰試験",
								proposals: [
									{
										title: "件数の回帰",
										instruction: "集計関数を修正して再試験する",
										acceptance: ["期待件数2"],
										mode: "edit",
										authorityQuote: utterance,
										after: null,
										verification: null,
										readablePaths: ["sum.ts", "regression.test.ts"],
										writablePaths: ["sum.ts"],
										checks: [
											{
												executable: process.execPath,
												cwd: root,
												args: ["test", "regression.test.ts"],
											},
										],
									},
								],
							},
						};
					}
					if (
						Array.isArray(data.amendments) &&
						data.callsLeft === undefined &&
						Object.keys(data).length < 6
					)
						return { decision: { mode: "edit" } };
					if (data.child && data.design && !refs().length)
						return {
							decision: {
								action: "finish",
								status: "failed",
								reason: "現行の作業に実行証跡がありません。",
							},
						};
					if (data.child && data.design)
						return {
							decision: {
								action: "accept",
								reason: conclusion,
								refs: refs(),
							},
						};
					if (
						data.executionsLeft !== undefined &&
						data.observation?.state === "failed"
					)
						return {
							decision: {
								action: "finish",
								status: "failed",
								memo: "",
								summary: "runnerの実行が失敗しました。",
								fulfilled: [],
								missing: ["実行証跡"],
								refs: [],
							},
						};
					if (data.executionsLeft !== undefined)
						return {
							decision:
								data.observation?.state === "finished"
									? {
											action: "finish",
											status: "completed",
											memo: "",
											summary: "実行終了",
											fulfilled: ["固定試験"],
											missing: [],
											refs: refs(),
										}
									: {
											action: "invoke",
											summary: "固定試験と修正",
											memo: "",
											instruction: editInstruction,
										},
						};
				},
			},
		});
		const h = a.h;
		try {
			const supervisor = h.toolchain.developmentSupervision;
			await h.store.write((db) =>
				h.toolchain.capabilities.publishToolchainRevisionInTransaction(
					db,
					"claude-code.request",
					"toolchain:claude-code.request@7",
				),
			);
			const goals = createGoalsService();
			shared = await seedSupervisionSharedContext(h, goals);
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
				context: { memory: h.memory!, goals, world: shared?.world },
				knowledge: {
					selectForSupervision: async () => [],
					supervisionSkillCurrentInTransaction: () => false,
				},
			});
			await a.start();
			const { source } = await ask(
				a,
				"development-supervision.request",
				utterance,
			);
			const progress = () =>
				h.store.read((db) =>
					supervisor.boardRowsInTransaction(db, {
						conversationId: "ao",
					}),
				);
			for (let attempt = 0; attempt < 250 && !entered; attempt++) {
				await supervisor.recover();
				void h.toolchain.claudeCode.recover();
				await a.advance(1000);
				await Bun.sleep(15);
			}
			expect(entered).toBe(true);
			const chat = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "ao",
				text: "別の話ですが、挨拶をお願いします。",
			});
			for (
				let attempt = 0;
				attempt < 250 && h.dialogue.get(chat.id)?.status !== "completed";
				attempt++
			)
				await Bun.sleep(15);
			expect(h.dialogue.get(chat.id)?.status).toBe("completed");
			const messages = conversationSchema.parse(
				await (await h.request("/api/conversations/ao")).json(),
			).messages;
			expect(
				messages.some(
					(message) =>
						message.role === "assistant" &&
						message.runId === chat.id &&
						!!message.text,
				),
			).toBe(true);
			expect(observed.facts).toEqual([]);
			expect(progress()[0]?.state).not.toBe("finished");
			checkGate.resolve();
			const finishBy = Date.now() + (live ? 120_000 : 10_000);
			while (Date.now() < finishBy && !reportLine(a)) {
				await supervisor.recover();
				await h.toolchain.claudeCode.recover();
				await a.advance(1000);
				await Bun.sleep(live ? 75 : 15);
			}
			const checks = observed.facts
				.filter((fact) => fact.kind === "check")
				.map((fact) => fact.passed);
			// The agent reports the verified outcome once: one line, no open item.
			await until(a, () => !!reportLine(a));
			expect(items(a)).toHaveLength(0);
			expect(
				h.conversation
					.get("ao")
					.messages.filter((message) => message.id.startsWith("agency:")),
			).toHaveLength(1);
			expect(checks).toEqual([false, true]);
			expect(h.dialogue.get(source.runId)?.status).toBe("completed");
			const check = observed.facts.findLast(
				(fact) => fact.kind === "check" && fact.passed,
			);
			const edit = observed.facts.find(
				(fact) => fact.kind === "edit" && fact.path === file,
			);
			expect(edit).toBeDefined();
			expect(check?.inputDigest).toBe(
				claudeInputDigest([file, join(root, "regression.test.ts")]),
			);
			expect(edit?.inputDigest).toBe(check?.inputDigest);
			expect(edit?.executionId).toBe(check?.executionId);
			// The shared context reached the design, and the design reached the runner with its citations.
			const evidence = shared
				? checkSupervisionSharedContext(shared, designerNotes)
				: [];
			if (shared) {
				expect(evidence).toEqual(
					checkSupervisionSharedContext(shared, plannerNotes),
				);
				for (const source of evidence)
					expect(observed.instructions[0]).toContain(sourceCitation(source));
			}
			expect(observed.instructions).toHaveLength(1);
			expect(observed.instructions[0]).toContain(design);
			expect(observed.instructions[0]).toContain(
				`## 作業範囲\n集計関数を修正して再試験する\n\n## 受入条件\n- 期待件数2\n\n## 今回の実行指示\n${editInstruction}`,
			);
			expect(readFileSync(draft, "utf8")).toBe("operator's existing change\n");
			expect(git("diff", "--name-only").toString().trim().split("\n")).toEqual([
				"operator.txt",
				"sum.ts",
			]);
			if (live)
				console.info(
					JSON.stringify({
						run: "supervised-edit",
						elapsedMs: Math.round(performance.now() - startAt),
						fixtureModelCalls: h.calls,
						turns: observed.turns,
						sources: evidence.map(sourceCitation),
						executionId: edit?.executionId,
						evidence: refs(),
						checks,
						delivered: 1,
					}),
				);
		} finally {
			checkGate.resolve();
			await a.close();
			await privateRunner?.close();
			if (privateDirectory)
				rmSync(privateDirectory, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	},
	live ? 150_000 : 30_000,
);
