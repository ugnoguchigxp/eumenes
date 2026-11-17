import { expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../toolchain/toolchain.fixture";
import type { HarnessOptions } from "../toolchain/toolchain-harness-options.fixture";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { copySourceSnapshot, resolveSourceCommit } from "./source-snapshot";
import { sourceResult } from "./source-report";
import { createCodexSourceInspect } from "./codex-source-inspect";
import { copySourceWorktree } from "./source-worktree";
import { sourceExcerpt } from "./source-excerpt";
import { spokenText } from "../../domains/delivery";
import { createContinuityService } from "../../domains/continuity";
import { testConversationAgent } from "../../domains/dialogue/test/conversation-agent.fixture";

const request =
	"Eumenes の初期化はどのファイルからどの関数へ進みますか。行番号を添えてください。";
const signal = () => AbortSignal.timeout(30_000);
const followUp = "もう一つ、こんにちは。";
const followUpAnswer = "こんにちは。";

async function submitVoice(
	h: Awaited<ReturnType<typeof harness>>,
	session: string,
	sequence: number,
) {
	const utterance = crypto.randomUUID();
	const wav = new Uint8Array(48);
	wav.set(new TextEncoder().encode("RIFF"));
	wav.set(new TextEncoder().encode("WAVE"), 8);
	await h.voice.accept(session, 1, sequence, utterance, wav);
	await waitFor(() => h.voice.get(utterance)?.status === "input_ready");
	await h.voice.commit(utterance, h.voice.get(utterance)!.revision);
	await waitFor(() => Boolean(h.voice.get(utterance)?.runId));
	return { utterance, runId: h.voice.get(utterance)!.runId! };
}

async function conversation(
	source: NonNullable<Awaited<ReturnType<typeof createCodexSourceInspect>>>,
	question = request,
	voice = false,
) {
	const release = Promise.withResolvers<void>();
	let calls = 0;
	const options: HarnessOptions = {
		voiceText: question,
		conversationAgent: { ...testConversationAgent, handsWork: () => true },
		webNote: {
			inspectSource: {
				...source,
				async inspect(input) {
					calls++;
					const [result] = await Promise.all([
						source.inspect(input),
						release.promise,
					]);
					return result;
				},
			},
		},
		discoveryTarget: (text) =>
			text.includes(question) ? "inspect_source" : "service_search",
		firstRound: (_tools, asked, messages) => {
			if (asked === followUp) return { text: followUpAnswer };
			if (asked !== question) return;
			return searchThenDelegate(
				(candidate) => candidate.id === "inspect.source",
				question,
				{ impact: "none" },
			)(messages);
		},
	};
	const h = await harness(options);
	try {
		const session = voice ? crypto.randomUUID() : null;
		if (session) h.voice.start(session, 1);
		const initial = session ? await submitVoice(h, session, 1) : null;
		const runId =
			initial?.runId ??
			(
				await h.dialogue.submit({
					requestId: crypto.randomUUID(),
					conversationId: "main",
					text: question,
				})
			).id;
		if (initial) {
			// An existing voice handover waits for the browser to acknowledge the announcement.
			await waitFor(
				() => !!h.voice.get(initial.utterance)?.audioChunks?.length,
			);
			expect(calls).toBe(0);
			await h.voice.played(
				initial.utterance,
				h.voice.get(initial.utterance)!.audioChunks![0]!.index,
			);
		}
		expect(
			await h.dialogue.waitForTerminal(runId, { timeoutMs: 5000 }),
		).toMatchObject({ status: "completed", announcement: expect.any(String) });
		await waitFor(() => calls > 0, { timeout: 10_000 });
		if (session) {
			options.voiceText = followUp;
			const next = await submitVoice(h, session, 2);
			await waitFor(() => h.dialogue.get(next.runId)?.status === "completed");
			expect(h.dialogue.answerText(next.runId)).toBe(followUpAnswer);
			await waitFor(
				() => (h.voice.get(next.utterance)?.audioChunks?.length ?? 0) > 0,
			);
		}
		const answers = async () => {
			const history = (await (
				await h.request("/api/conversations/main")
			).json()) as ReturnType<typeof h.conversation.get>;
			return history.messages.filter(
				(message) => message.role === "assistant" && message.displayText,
			);
		};
		expect(await answers()).toEqual([]);
		release.resolve();
		await waitFor(async () => (await answers()).length > 0, {
			timeout: 90_000,
			interval: 50,
		});
		await h.toolchain.webNote.recover();
		const messages = await answers();
		expect(calls).toBe(1);
		expect(messages).toHaveLength(1);
		const answer = messages[0]!;
		expect(
			(await (await h.request("/api/todo-notices")).json()).notices,
		).toEqual([]);
		expect(
			h.conversation
				.get("main")
				.messages.every((message) => message.displayText === undefined),
		).toBe(true);
		// Steward reads the said event and its backing message, without the display payload.
		const { events } = createContinuityService();
		h.store.read((db) => {
			const said = events
				.ofMessageInTransaction(db, answer.id)
				.find((event) => event.type === "said");
			expect(JSON.parse(said!.text!)).toMatchObject({ text: answer.text });
			const message = h.conversation.messageInTransaction(
				db,
				answer.id,
			)!.message;
			expect(message.text).toBe(answer.text);
			expect(message.displayText).toBeUndefined();
		});
		return answer;
	} finally {
		release.resolve();
		await h.close();
	}
}

test("a second voice turn gets a reply while source inspection is pending", async () => {
	const answer = await conversation(
		{
			resolveCommit: async () => "a".repeat(40),
			inspect: async () => ({
				usage: null,
				result: {
					status: "completed",
					summary: "初期化を確認しました。",
					answer: "初期化を確認しました。",
					replyInConversation: true,
					fulfilled: [],
					missing: [],
					refs: [],
					displayAnswer:
						"> ソース：`api/start.ts`\n\n```\nconst value = 1;\n```",
				},
			}),
		},
		request,
		true,
	);
	expect(answer.displayText).toContain("api/start.ts");
}, 20_000);

test("diff excerpts are limited to authorized snapshots and stay out of memory input and playback", async () => {
	const root = await mkdtemp(join(tmpdir(), "eumenes-inspect-fixture-"));
	const repository = join(root, "repo");
	try {
		await mkdir(join(repository, "api", "fixtures"), { recursive: true });
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["/usr/bin/git", ...args], {
				cwd: repository,
				env: {
					PATH: "/usr/bin:/bin",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
				},
			});
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		};
		git("init");
		await writeFile(join(repository, "api", "start.ts"), "first\nsecond\n");
		await writeFile(join(repository, "api", ".env"), "fixture secret");
		await writeFile(
			join(repository, "api", "fixtures", "ignored.ts"),
			"fixture",
		);
		await symlink(".env", join(repository, "api", "outside.ts"));
		git("add", ".");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.test",
			"commit",
			"-m",
			"fixture",
		);
		const commit = await resolveSourceCommit(repository, signal());
		await writeFile(join(repository, "api", "start.ts"), "uncommitted\n");
		git("add", "api/start.ts");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.test",
			"commit",
			"-m",
			"next",
		);
		const current = await resolveSourceCommit(repository, signal());
		await writeFile(join(repository, "api", "start.ts"), "dirty worktree\n");
		const directory = join(root, "snapshot");
		const lines = await copySourceSnapshot(
			repository,
			directory,
			commit,
			signal(),
		);
		expect([...lines]).toEqual([["api/start.ts", 2]]);
		expect(await readFile(join(directory, "api/start.ts"), "utf-8")).toBe(
			"first\nsecond\n",
		);

		const working = join(root, "working");
		const snapshot = await copySourceWorktree(
			repository,
			working,
			lines,
			signal(),
		);
		expect([...snapshot.current]).toEqual([["api/start.ts", 1]]);
		const response = JSON.stringify({
			depth: "medium",
			findings: [
				{
					summary: `api/start.ts ${commit} 確認できた初期化`,
					evidence: [{ path: "api/start.ts", startLine: 1, endLine: 1 }],
				},
				{
					summary: "根拠が無効な主張",
					evidence: [
						{ path: "api/start.ts", startLine: 3, endLine: 4 },
						{ path: "api/outside.ts", startLine: 1, endLine: 1 },
					],
				},
			],
			limitations: "",
		});
		const answer = await conversation({
			resolveCommit: async () => commit,
			inspect: async (input) => {
				expect(input.commit).toBe(commit);
				expect(input.prompt).toContain(request);
				return {
					result: await sourceResult(
						response,
						snapshot.current,
						({ path, startLine, endLine }) =>
							sourceExcerpt(
								directory,
								working,
								path,
								true,
								true,
								startLine,
								endLine,
								input.signal,
							),
					),
					usage: null,
				};
			},
		});
		expect(answer.text).toBe("確認できた初期化");
		expect(answer.displayText).not.toContain("根拠が無効な主張");
		expect(answer.displayText).toContain("一部抜粋（表示深度：中）");
		expect(answer.displayText).toContain("> **ソース：** `api/start.ts`");
		expect(answer.displayText).toContain("```diff");
		expect(answer.displayText).toContain("-first");
		expect(answer.displayText).toContain("+dirty worktree");
		expect(answer.displayText).not.toContain(commit);
		expect(spokenText(answer.text)).toBe("確認できた初期化");
		expect(await resolveSourceCommit(repository, signal())).toBe(current);
		expect(await readFile(join(repository, "api", "start.ts"), "utf-8")).toBe(
			"dirty worktree\n",
		);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
}, 30_000);

test.each([
	["small", "小", 3],
	["medium", "中", 4],
	["large", "大", 5],
] as const)(
	"%s publishes excerpts for at most %s's file limit",
	async (depth, label, max) => {
		const paths = Array.from({ length: 7 }, (_, i) => `api/source-${i}.ts`);
		const evidence = [...paths, paths[0]!].map((path) => ({
			path,
			startLine: 1,
			endLine: 1,
		}));
		const result = await sourceResult(
			JSON.stringify({
				depth,
				findings: [{ summary: "概要", evidence }],
				limitations: "",
			}),
			new Map(paths.map((path) => [path, 1])),
			async () => ({ kind: "code", text: "const fixture = true;" }),
		);
		expect(result.displayAnswer).toContain(`一部抜粋（表示深度：${label}）`);
		expect(result.displayAnswer?.match(/> \*\*ソース：/gu)).toHaveLength(max);
		expect(result.answer).toBe("概要");
	},
);

test("a report with no usable excerpt keeps neutral wording", async () => {
	const result = await sourceResult(
		JSON.stringify({ depth: "small", findings: [], limitations: "途中" }),
		new Map(),
		async () => null,
	);
	expect(result.status).toBe("partial");
	expect(result.displayAnswer).toContain("一部抜粋");
	expect(result.answer).not.toContain("失敗");
});

test.skipIf(!process.env.EUMENES_LIVE_SOURCE_INSPECTION)(
	"the real Codex SDK returns checked citations to the requesting chat",
	async () => {
		const source = await createCodexSourceInspect(
			process.env,
			"codex",
			process.cwd(),
		);
		expect(source).toBeDefined();
		const answer = await conversation(source!, request, true);
		expect(answer.displayText).toMatch(/ソース：.*api\//u);
	},
	100_000,
);
