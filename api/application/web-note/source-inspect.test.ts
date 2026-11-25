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
import type { harness } from "../toolchain/toolchain.fixture";
import {
	ask,
	assignmentAgenda,
	items,
	notes,
	until,
	works,
} from "../media/assignment.fixture";
import type { HarnessOptions } from "../toolchain/toolchain-harness-options.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { copySourceSnapshot, resolveSourceCommit } from "./source-snapshot";
import { sourceResult } from "./source-report";
import { createCodexSourceInspect } from "./codex-source-inspect";
import { copySourceWorktree } from "./source-worktree";
import { sourceExcerpt } from "./source-excerpt";
import { spokenText } from "../../domains/delivery";
import { testConversationAgent } from "../../domains/dialogue/test/conversation-agent.fixture";
import { sha256Hex } from "../../infrastructure/digest";

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

/**
 * The user asks the source inspection toolchain (the agent's assignment), the inspection is held until released, and
 * the user may talk by voice meanwhile. Returns what the inspection returned and the agent's work report note.
 */
async function conversation(
	source: NonNullable<Awaited<ReturnType<typeof createCodexSourceInspect>>>,
	question = request,
	voice = false,
) {
	const release = Promise.withResolvers<void>();
	let calls = 0;
	let returned: Awaited<ReturnType<typeof source.inspect>> | undefined;
	const options: HarnessOptions = {
		voiceText: followUp,
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
					returned = result;
					return result;
				},
			},
		},
		firstRound: (_tools, asked) => {
			if (asked === followUp) return { text: followUpAnswer };
		},
	};
	const a = await assignmentAgenda({ harness: options });
	const h = a.h;
	try {
		await a.start();
		const session = voice ? crypto.randomUUID() : null;
		if (session) h.voice.start(session, 1);
		await ask(a, "inspect.source", question);
		await until(a, () => calls > 0);
		// The inspection is the agent's open item while it runs; nothing is reported yet.
		expect(items(a)).toHaveLength(1);
		expect(notes(a)).toEqual([]);
		if (session) {
			const next = await submitVoice(h, session, 1);
			await waitFor(() => h.dialogue.get(next.runId)?.status === "completed");
			expect(h.dialogue.answerText(next.runId)).toBe(followUpAnswer);
			await waitFor(
				() => (h.voice.get(next.utterance)?.audioChunks?.length ?? 0) > 0,
			);
		}
		release.resolve();
		await until(a, () => notes(a).length === 1);
		expect(calls).toBe(1);
		expect(items(a)).toHaveLength(0);
		expect(works(a)).toHaveLength(1);
		return { result: returned!.result, note: notes(a)[0]!, a };
	} finally {
		release.resolve();
		await a.close();
	}
}

test("a second voice turn gets a reply while the source inspection assignment is pending", async () => {
	const { result, note } = await conversation(
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
	// The agent reports the inspection with a work report note: the request and what it answered.
	expect(note.markdown).toContain(`## 依頼\n\n${request}`);
	expect(note.markdown).toContain("初期化を確認しました。");
	expect(result.displayAnswer).toContain("api/start.ts");
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
					evidence: [
						{ path: "api/start.ts", symbol: "start", startLine: 1, endLine: 1 },
					],
				},
				{
					summary: "根拠が無効な主張",
					evidence: [
						{ path: "api/start.ts", symbol: null, startLine: 3, endLine: 4 },
						{ path: "api/outside.ts", symbol: null, startLine: 1, endLine: 1 },
					],
				},
			],
			limitations: "",
		});
		const { result: reported, note } = await conversation({
			resolveCommit: async () => commit,
			inspect: async (input) => {
				expect(input.commit).toBe(commit);
				expect(input.prompt).toContain(request);
				const result = await sourceResult(
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
					commit,
				);
				expect(result.report?.sources).toEqual([
					{
						sourceId: "source-1",
						kind: "source",
						location: {
							path: "api/start.ts",
							symbol: "start",
							startLine: 1,
							endLine: 1,
							commit,
							digest: sha256Hex("dirty worktree"),
						},
					},
				]);
				return {
					result,
					usage: null,
				};
			},
		});
		expect(reported.answer).toBe("確認できた初期化");
		const display = reported.displayAnswer!;
		expect(display).not.toContain("根拠が無効な主張");
		expect(display).toContain("一部抜粋（表示深度：中）");
		expect(display).toContain("> **ソース：** `api/start.ts`");
		expect(display).toContain("```diff");
		expect(display).toContain("-first");
		expect(display).toContain("+dirty worktree");
		expect(display).not.toContain(commit);
		expect(spokenText(reported.answer!)).toBe("確認できた初期化");
		// The excerpts are for the screen: the agent's note holds the answer and no diff.
		expect(note.markdown).toContain("確認できた初期化");
		expect(note.markdown).not.toContain("dirty worktree");
		expect(note.markdown).not.toContain(commit);
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
			symbol: null,
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
			async () => ({
				kind: "code",
				text: "const fixture = true;",
				digest: sha256Hex("const fixture = true;"),
			}),
			"fixture-commit",
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
		"fixture-commit",
	);
	expect(result.status).toBe("partial");
	expect(result.displayAnswer).toContain("一部抜粋");
	expect(result.answer).not.toContain("失敗");
});

test("a source citation keeps its original bytes and shows the cited lines when the diff is elsewhere", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "eumenes-inspect-excerpt-fixture-"),
	);
	const before = join(root, "before"),
		current = join(root, "current");
	const cited = "\uFEFFexport const cited = 2;";
	const lines = [cited, ...Array.from({ length: 10 }, (_, i) => `// ${i}`)];
	try {
		await Promise.all([mkdir(before), mkdir(current)]);
		await Promise.all([
			writeFile(
				join(before, "fixture.ts"),
				[...lines, "export const unrelated = 3;"].join("\n"),
			),
			writeFile(
				join(current, "fixture.ts"),
				[...lines, "export const unrelated = 4;"].join("\n"),
			),
		]);
		expect(
			await sourceExcerpt(
				before,
				current,
				"fixture.ts",
				true,
				true,
				1,
				1,
				signal(),
			),
		).toEqual({
			kind: "code",
			text: cited,
			digest: sha256Hex(cited),
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test.skipIf(!process.env.EUMENES_LIVE_SOURCE_INSPECTION)(
	"the real Codex SDK returns versioned citations from an isolated synthetic checkout",
	async () => {
		const repository = await mkdtemp(
			join(tmpdir(), "eumenes-inspect-live-fixture-"),
		);
		try {
			await mkdir(join(repository, "api"));
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
			const path = join(repository, "api", "start.ts");
			await writeFile(path, "export function start() {\n  return 11;\n}\n");
			git("add", "api/start.ts");
			git(
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.test",
				"commit",
				"-m",
				"fixture",
			);
			const current = "export function start() {\n  return 17;\n}\n";
			await writeFile(path, current);
			const source = await createCodexSourceInspect(
				{
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					CODEX_HOME: process.env.CODEX_HOME,
				},
				"codex",
				repository,
			);
			expect(source).toBeDefined();
			const commit = await source!.resolveCommit(signal());
			const { result } = await source!.inspect({
				commit,
				prompt:
					"現在の start 関数が返す数値を確認してください。変更の実行は不要です。",
				signal: AbortSignal.timeout(90_000),
			});
			expect(result.answer).toContain("17");
			const citation = result.report?.sources.find(
				({ location }) => location?.path === "api/start.ts",
			)?.location;
			expect(citation).toMatchObject({ commit, symbol: "start" });
			const excerpt = current
				.split("\n")
				.slice(citation!.startLine - 1, citation!.endLine)
				.join("\n");
			expect(citation!.digest).toBe(sha256Hex(excerpt));
			expect(await readFile(path, "utf-8")).toBe(current);
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	},
	100_000,
);
