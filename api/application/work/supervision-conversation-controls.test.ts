import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../../domains/claude-code";
import type { ClaudeObservation } from "../../domains/coding";
import { createGoalsService } from "../../domains/goals";
import type { Messages } from "../../domains/inference/contracts";
import { fixture as markdownFixture } from "../../domains/markdown/test/workspace.fixture";
import { createTerminals } from "../../domains/terminals";
import { waitFor } from "../../infrastructure/wait-for";
import {
	afterUtterance,
	searchThenDelegate,
	type Step,
} from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";
import { configureDevelopmentSupervision } from "./development-supervision-host";

const request = "入力処理を読んでください。集計の試験も実行してください。";
const separateRequest = "別件としてログ出力の設計も調べてください。";
const ownerPrompt = "入力はどれを対象にしますか。";
const runnerPrompt = "集計の期待値を教えてください。";
const readerTitle = "入力の読取り (30000000-a314-4000-8000-000000000001)";
const checkTitle = "集計の検証";

function structured(root: string, messages: Messages) {
	if (messages[0]?.content.includes("あなたは依頼の設計担当です"))
		return {
			status: "ready",
			title: "入力と集計",
			summary: "固定された設計",
			markdown: "# 設計\n入力処理と集計を確認する。",
			sources: [],
			missing: null,
		};
	let data;
	try {
		data = JSON.parse(messages.at(-1)!.content);
	} catch {
		return;
	}
	if (data.researchRemaining !== undefined) {
		if (data.originalRequest === separateRequest)
			return { decision: { action: "hold", reason: "対象ログの指定待ち" } };
		const proposal = {
			after: null,
			verification: null,
			authorityQuote: request,
			readablePaths: ["input.ts"],
			writablePaths: [],
		};
		return {
			decision: {
				action: "design",
				mode: "execute",
				title: "入力と集計",
				analysis: "二つの作業は独立。",
				guideQuery: "固定試験",
				proposals: [
					{
						...proposal,
						title: readerTitle,
						mode: "read",
						instruction: "入力を読む。",
						acceptance: ["入力を読む"],
						checks: [],
					},
					{
						...proposal,
						title: checkTitle,
						mode: "verify",
						instruction: "集計を確認する。",
						acceptance: ["集計を試験する"],
						checks: [
							{
								executable: process.execPath,
								cwd: root,
								args: ["test", "input.ts"],
							},
						],
					},
				],
			},
		};
	}
	if (data.executionsLeft !== undefined) {
		if (data.mode === "read" && !data.answers.length)
			return {
				decision: {
					action: "ask_user",
					question: ownerPrompt,
					summary: "入力を確認します。",
					memo: "",
				},
			};
		return {
			decision: {
				action: "invoke",
				summary: "対象作業を実行します。",
				instruction: "指定の作業を実施する。",
				memo: "",
			},
		};
	}
	if (Array.isArray(data.amendments)) return { decision: { mode: "verify" } };
}

function seed(root: string) {
	writeFileSync(join(root, "input.ts"), "export const input = [1, 2];\n");
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
	git("init", "-q");
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
		"fixture",
	);
}

test("conversation work preserves the promoted question and controls the specified task at its observed revision", async () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "eumenes-supervision-controls-")),
	);
	seed(root);
	const observations = new Map<string, ClaudeObservation>();
	const starts = new Map<"verify" | "read" | "edit", string>();
	const replies: { id: string; answer: string }[] = [];
	const stopped: string[] = [];
	const runner: Runner = {
		ready: () => true,
		supportsSupervised: () => true,
		probe: async () => true,
		async start(spec) {
			const supervised = spec.supervised!;
			starts.set(supervised.authorization.mode, spec.id);
			const observed: ClaudeObservation = {
				executionId: spec.id,
				supervised,
				state: "running",
				seq: 1,
				managedExecutionStopped: false,
			};
			observations.set(spec.id, observed);
			return observed;
		},
		inspect: async (id) => observations.get(id) ?? null,
		async present(id, question, expiresAt) {
			const current = observations.get(id)!;
			expect(current.question?.id).toBe(question);
			current.question = {
				...current.question!,
				expiresAt,
				presentation: "presented",
			};
		},
		async reply(id, operationId, questionId, answer) {
			const current = observations.get(id)!;
			expect(current.question?.id).toBe(questionId);
			replies.push({ id, answer });
			const updated: ClaudeObservation = {
				...current,
				state: "running",
				seq: current.seq + 1,
				question: undefined,
				answerReceipt: { operationId, questionId },
			};
			observations.set(id, updated);
			return updated;
		},
		async stop(id) {
			stopped.push(id);
			const current = observations.get(id)!;
			const updated: ClaudeObservation = {
				...current,
				state: "stopped",
				seq: current.seq + 1,
				managedExecutionStopped: true,
			};
			observations.set(id, updated);
			return updated;
		},
		async approveTool() {},
		async recover() {
			throw new Error("unexpected fixture recovery");
		},
	};
	const archive = markdownFixture();
	let todo = "t1";
	let target = "";
	const readToolOutput = new Map<string, string>();
	const calls = new Map<string, Step["calls"]>();
	const h = await harness({
		markdown: archive.archive,
		memory: true,
		webNote: {},
		claudeRunner: runner,
		terminals: (store) =>
			createTerminals({
				store,
				command: ["fixture"],
				spawn: () => {
					throw new Error("unexpected terminal");
				},
			}),
		discoveryTarget: () => "development_supervision",
		firstRound: (_tools, text, messages) => {
			if (text === request || text === separateRequest) {
				return searchThenDelegate(
					(card) => card.id === "development-supervision.request",
					text,
					{ impact: "none", announcement: "開発調査を進めます。" },
				)(messages);
			}
			const exchanged = afterUtterance(messages);
			if (exchanged.length) {
				readToolOutput.set(
					text,
					exchanged.map(({ content }) => content).join("\n"),
				);
				return { text: "確認しました。" };
			}
			const operation =
				text === "対象の進捗を教えてください。"
					? "check"
					: text.includes("取消")
						? "cancel"
						: "answer";
			const selection =
				operation === "check" || text === "集計の作業だけ取消してください。"
					? { target }
					: {};
			const step = {
				calls: [{ name: "work", args: { todo, operation, ...selection } }],
			};
			calls.set(text, step.calls);
			return step;
		},
		structuredResponse: (messages) => structured(root, messages),
	});
	try {
		const owner = h.toolchain.developmentSupervision;
		await h.store.write((db) =>
			h.toolchain.capabilities.publishToolchainRevisionInTransaction(
				db,
				"claude-code.request",
				"toolchain:claude-code.request@7",
			),
		);
		configureDevelopmentSupervision({
			supervisor: owner,
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
		h.toolchain.claudeCode.start();
		const turn = (text: string) =>
			h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			});
		const rows = () =>
			h.store.read((db) =>
				owner.boardRowsInTransaction(db, { conversationId: "main" }),
			);
		const initial = await turn(request);
		await waitFor(
			() =>
				!!starts.get("verify") &&
				h.todos().some(({ question }) => question === ownerPrompt),
			{ timeout: 8_000 },
		).catch(() => {
			throw new Error(
				JSON.stringify({
					initial: h.dialogue.get(initial.id)?.status,
					answer: h.dialogue.answerText(initial.id),
					todos: h.todos(),
					rows: rows(),
					starts: [...starts.keys()],
				}),
			);
		});
		const verifier = starts.get("verify")!;
		const shown = h.todos().find(({ question }) => question === ownerPrompt)!;
		todo = `t${shown.ref}`;
		const separate = await turn(separateRequest);
		expect(
			(await h.dialogue.waitForTerminal(separate.id, { timeoutMs: 5_000 }))
				?.status,
		).toBe("completed");
		const open = h.todos();
		expect(
			open.filter(
				({ toolchainId }) => toolchainId === "development-supervision.request",
			),
		).toHaveLength(2);
		expect(open.find(({ id }) => id === shown.id)?.questionId).toBe(
			shown.questionId,
		);
		target = rows().find(({ title }) => title === checkTitle)!.taskId;
		const verifyWork = observations.get(verifier)!;
		verifyWork.seq++;
		verifyWork.state = "waiting";
		verifyWork.question = {
			id: crypto.randomUUID(),
			prompt: runnerPrompt,
			expiresAt: verifyWork.supervised!.authorization.deadline,
			inputSchema: { type: "string" },
			presentation: "waiting",
		};
		await waitFor(() =>
			rows().some(({ reason }) => reason === "質問の提示待ち"),
		);
		const answer1 = await turn("入力は配列です。");
		await waitFor(() => h.dialogue.get(answer1.id)?.status === "completed");
		const second = h.todos().find(({ question }) => question === runnerPrompt)!;
		expect(second).toMatchObject({ status: "waiting", ref: shown.ref });
		expect(second.questionId).not.toBe(shown.questionId);
		const answer2 = await turn("期待値は2件です。");
		await waitFor(
			() =>
				h.dialogue.get(answer2.id)?.status === "completed" &&
				replies.length === 1,
		);
		expect(replies).toEqual([{ id: verifier, answer: "期待値は2件です。" }]);
		const check = await turn("対象の進捗を教えてください。");
		await waitFor(() => h.dialogue.get(check.id)?.status === "completed");
		const status = readToolOutput.get("対象の進捗を教えてください。");
		expect(status).toContain(target);
		expect(status).not.toContain(
			rows().find(({ title }) => title === readerTitle)!.taskId,
		);
		expect(status).toContain(
			`"revision":${rows().find(({ taskId }) => taskId === target)!.revision}`,
		);
		const noScope = await turn("作業の取消をお願いします。");
		await waitFor(() => h.dialogue.get(noScope.id)?.status === "completed");
		expect(readToolOutput.get("作業の取消をお願いします。")).toContain(
			"work_target_required",
		);
		expect(stopped).toEqual([]);
		await waitFor(() =>
			rows().some((row) => row.taskId === target && row.state === "running"),
		);
		const cancel = await turn("集計の作業だけ取消してください。");
		await waitFor(
			() =>
				h.dialogue.get(cancel.id)?.status === "completed" &&
				rows().some((row) => row.taskId === target && row.state === "finished"),
			{ timeout: 8_000 },
		).catch(() => {
			throw new Error(
				JSON.stringify({
					turn: h.dialogue.get(cancel.id)?.status,
					output: readToolOutput.get("集計の作業だけ取消してください。"),
					rows: rows(),
					stopped,
				}),
			);
		});
		expect(
			calls.get("集計の作業だけ取消してください。")?.at(0)?.args.target,
		).toBe(target);
		expect(stopped).toEqual([verifier]);
		expect(rows().find(({ taskId }) => taskId === target)).toMatchObject({
			outcome: "cancelled",
		});
		expect(rows().find(({ title }) => title === readerTitle)?.state).not.toBe(
			"finished",
		);
	} finally {
		await h.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 25_000);
