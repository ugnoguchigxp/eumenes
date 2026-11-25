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
import { replyWith } from "../agency/always-on.fixture";
import {
	ask,
	assignmentAgenda,
	cancelAssignment,
	card,
	items,
	until,
	userWords,
} from "../media/assignment.fixture";
import { configureDevelopmentSupervision } from "./development-supervision-host";

const TOOLCHAIN = "development-supervision.request";
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

test("the agent holds the owner's questions as the assignment's question, passes the user's answers to the question that is open, and a cancel stops the assignment's works", async () => {
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
	const a = await assignmentAgenda({
		harness: {
			markdown: archive.archive,
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
			structuredResponse: (messages) => structured(root, messages),
		},
	});
	const h = a.h;
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
		await a.start();
		const rows = () =>
			h.store.read((db) =>
				owner.boardRowsInTransaction(db, { conversationId: "ao" }),
			);
		const supervised = () =>
			items(a).filter(
				({ delegatedTo }) => delegatedTo === card(a, TOOLCHAIN).title,
			);
		const first = await ask(a, TOOLCHAIN, request);
		await until(
			a,
			() =>
				!!starts.get("verify") &&
				supervised().some(({ question }) => question === ownerPrompt),
		).catch(() => {
			throw new Error(
				JSON.stringify({
					items: items(a),
					rows: rows(),
					starts: [...starts.keys()],
				}),
			);
		});
		const verifier = starts.get("verify")!;
		const shown = supervised().find(
			({ question }) => question === ownerPrompt,
		)!;
		expect(shown.id).toBe(first.id);
		// A separate request is a separate assignment; the first one keeps the question it is asking.
		const separate = await ask(a, TOOLCHAIN, separateRequest);
		await until(a, () => supervised().length === 2);
		expect(supervised().map(({ id }) => id)).toEqual([first.id, separate.id]);
		expect(supervised().find(({ id }) => id === first.id)?.question).toBe(
			ownerPrompt,
		);
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
		await until(a, () =>
			rows().some(({ reason }) => reason === "質問の提示待ち"),
		);
		// The user's answer goes to the question that is open; the runner's question follows it.
		const answer = (id: string, text: string) =>
			userWords(a, text).then((words) =>
				replyWith(
					a,
					[{ name: "assignment", arguments: { id, action: "answer", text } }],
					{
						runId: `run-${crypto.randomUUID()}`,
						messageIds: [words.messageId],
					},
				),
			);
		const answered = await answer(first.id, "入力は配列です。");
		expect(
			answered.seen[1]!.filter((m) => m.role === "tool").map((m) => m.content),
		).toEqual([`answered: ${card(a, TOOLCHAIN).title}に回答を渡した`]);
		await until(a, () =>
			supervised().some(({ question }) => question === runnerPrompt),
		);
		expect(
			supervised().find(({ question }) => question === runnerPrompt)?.id,
		).toBe(first.id);
		await answer(first.id, "期待値は2件です。");
		await until(a, () => replies.length === 1);
		expect(replies).toEqual([{ id: verifier, answer: "期待値は2件です。" }]);
		expect(stopped).toEqual([]);
		// The check is running when the user stops the assignment.
		await until(a, () =>
			rows().some((row) => row.title === checkTitle && row.state === "running"),
		);
		const cancelled = await cancelAssignment(
			a,
			first.id,
			"調べるのをやめてください。",
		);
		expect(
			cancelled.seen[1]!.filter((m) => m.role === "tool").map((m) => m.content),
		).toEqual([`cancelled: ${card(a, TOOLCHAIN).title}への依頼をやめた`]);
		await until(a, () => stopped.includes(verifier));
		expect(supervised().map(({ id }) => id)).toEqual([separate.id]);
		expect(rows().find(({ title }) => title === checkTitle)).toMatchObject({
			outcome: "cancelled",
		});
	} finally {
		await a.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
