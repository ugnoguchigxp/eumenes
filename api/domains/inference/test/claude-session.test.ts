import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	hostHistoryStore,
	normalizeHistory,
	splitMessages,
	sweepClaudeTemp,
	trackClaudeRoot,
	transcriptEntries,
} from "../adapters/claude-session";

const invalid = () => new Error("invalid");
const m = (role: "system" | "user" | "assistant", content: string) => ({
	role,
	content,
});

test("the messages split by position: instructions, then the history, then this turn's input in order", () => {
	const parts = splitMessages(
		[
			m("system", "base"),
			m("system", "long-term"),
			m("user", "u1"),
			m("assistant", "a1"),
			m("system", "summary"),
			m("user", "u2"),
			m("assistant", "a2"),
			m("system", "notice"),
			m("user", "current"),
		],
		{ instructionCount: 2, historyCount: 4 },
		invalid,
	);
	expect(parts.instructions).toEqual(["base", "long-term"]);
	expect(parts.history).toEqual([
		{ role: "user", content: "u1" },
		{ role: "assistant", content: "a1" },
		{ role: "user", content: "u2" },
		{ role: "assistant", content: "a2" },
	]);
	expect(parts.turn).toEqual([
		m("system", "summary"),
		m("system", "notice"),
		m("user", "current"),
	]);
});

test("without a context only the leading system messages are instructions and nothing is history", () => {
	const parts = splitMessages(
		[m("system", "s"), m("user", "u"), m("system", "later"), m("user", "x")],
		undefined,
		invalid,
	);
	expect(parts.instructions).toEqual(["s"]);
	expect(parts.history).toEqual([]);
	expect(parts.turn).toHaveLength(3);
});

test("a context that does not fit the messages is refused", () => {
	const messages = [m("system", "s"), m("user", "u")];
	for (const context of [
		{ instructionCount: 3, historyCount: 0 },
		{ instructionCount: 1, historyCount: 2 },
		{ instructionCount: 2, historyCount: 0 },
		{ instructionCount: -1, historyCount: 0 },
	])
		expect(() => splitMessages(messages, context, invalid)).toThrow("invalid");
});

test("a history starts with a user turn and merges runs of one role", () => {
	expect(
		normalizeHistory([
			{ role: "assistant", content: "orphan answer" },
			{ role: "user", content: "a" },
			{ role: "user", content: "b" },
			{ role: "assistant", content: "  " },
			{ role: "assistant", content: "c" },
		]),
	).toEqual({
		turns: [
			{ role: "user", content: "a\n\nb" },
			{ role: "assistant", content: "c" },
		],
		pending: [],
	});
});

test("a trailing user turn nobody answered leaves the history as pending", () => {
	expect(
		normalizeHistory([
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
			{ role: "user", content: "failed run" },
			{ role: "user", content: "retry" },
		]),
	).toEqual({
		turns: [
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
		],
		pending: [{ role: "user", content: "failed run\n\nretry" }],
	});
});

test("the transcript entries are one parentUuid chain in the captured shape, identical for an identical history", () => {
	const history = [
		{ role: "user" as const, content: "u1" },
		{ role: "assistant" as const, content: "a1" },
	];
	const entries = transcriptEntries("sid", history, {
		cwd: "/work",
		model: "model-x",
	});
	expect(entries).toEqual([
		{
			parentUuid: null,
			isSidechain: false,
			sessionId: "sid",
			userType: "external",
			entrypoint: "sdk-ts",
			cwd: "/work",
			version: "2.1.289",
			gitBranch: "HEAD",
			type: "user",
			message: { role: "user", content: [{ type: "text", text: "u1" }] },
			uuid: "aaaaaaaa-0000-4000-8000-000000000001",
			timestamp: "2026-01-01T00:00:00.000Z",
		},
		{
			parentUuid: "aaaaaaaa-0000-4000-8000-000000000001",
			isSidechain: false,
			sessionId: "sid",
			userType: "external",
			entrypoint: "sdk-ts",
			cwd: "/work",
			version: "2.1.289",
			gitBranch: "HEAD",
			type: "assistant",
			message: {
				id: "msg_history_2",
				type: "message",
				role: "assistant",
				model: "model-x",
				content: [{ type: "text", text: "a1" }],
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: {
					input_tokens: 0,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					output_tokens: 0,
				},
			},
			uuid: "aaaaaaaa-0000-4000-8000-000000000002",
			timestamp: "2026-01-01T00:00:01.000Z",
		},
	]);
	// A longer history extends the same prefix, so an unchanged prefix stays byte-identical (prompt cache).
	const longer = transcriptEntries(
		"sid",
		[...history, { role: "user", content: "u2" }],
		{ cwd: "/work", model: "model-x" },
	);
	expect(JSON.stringify(longer.slice(0, 2))).toBe(JSON.stringify(entries));
});

test("the store loads the host's history only, drops what the SDK appends, and delete reaches the ledger", async () => {
	let deleted = 0;
	const entries = [{ type: "user", uuid: "u" }];
	const store = hostHistoryStore({
		sessionId: "sid",
		entries,
		onDelete: async () => {
			deleted++;
		},
	});
	await store.append({ projectKey: "eumenes-main", sessionId: "sid" }, [
		{ type: "user", uuid: "raw" },
	]);
	expect(
		await store.load({ projectKey: "eumenes-main", sessionId: "sid" }),
	).toEqual(entries);
	expect(
		await store.load({ projectKey: "eumenes-main", sessionId: "other" }),
	).toBeNull();
	expect(
		await store.load({
			projectKey: "eumenes-main",
			sessionId: "sid",
			subpath: "x",
		}),
	).toBeNull();
	await store.delete!({ projectKey: "eumenes-main", sessionId: "sid" });
	await store.delete!({ projectKey: "eumenes-main", sessionId: "other" });
	expect(deleted).toBe(1);
});

test("the sweep removes old leftovers of a crashed host and keeps what a running call or another process may own", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-sweep-"));
	try {
		const old = new Date(Date.now() - 3 * 60 * 60_000);
		const hour = 60 * 60_000;
		/** A directory whose files (and the directory) all carry `age`; `project` is a `projects/<key>` it holds. */
		const made = (name: string, age: Date | null, project?: string) => {
			const path = join(dir, name);
			mkdirSync(path);
			const file = project
				? join(path, "projects", project, "session.jsonl")
				: join(path, "file");
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "x");
			if (age)
				for (
					let target = file;
					target.length >= path.length;
					target = dirname(target)
				)
					utimesSync(target, age, age);
			return { path, file };
		};
		const resume = (n: number) =>
			`claude-resume-123e4567-e89b-42d3-a456-42661417400${n}`;
		const staleRoot = made("eumenes-agent-stale", old).path;
		const staleResume = made(resume(0), old, "eumenes-main").path;
		const staleSubagent = made(resume(5), old, "eumenes-subagent").path;
		const youngResume = made(resume(1), null, "eumenes-main").path;
		// The directory looks old, but a file inside was written a moment ago: the call is still running.
		const busy = made(resume(2), old, "eumenes-main");
		utimesSync(busy.file, new Date(), new Date());
		const busyRoot = made("eumenes-agent-busy", old);
		utimesSync(busyRoot.file, new Date(), new Date());
		// Another program's resume copy (no host project key) is never ours.
		const foreign = made(resume(3), old, "some-other-project").path;
		const other = made("claude-other", old).path;
		const notResume = made(
			"claude-resume-not-a-uuid",
			old,
			"eumenes-main",
		).path;
		const liveRoot = made("eumenes-agent-live", old).path;
		const untrack = trackClaudeRoot(liveRoot);
		// The call that owns `liveRoot` is running: its root stays however old the directory looks.
		expect(await sweepClaudeTemp(hour, dir)).toBe(3);
		expect(existsSync(liveRoot)).toBe(true);
		untrack();
		expect(await sweepClaudeTemp(hour, dir)).toBe(1);
		expect(existsSync(staleRoot)).toBe(false);
		expect(existsSync(staleResume)).toBe(false);
		expect(existsSync(staleSubagent)).toBe(false);
		expect(existsSync(liveRoot)).toBe(false);
		for (const kept of [
			youngResume,
			busy.path,
			busyRoot.path,
			foreign,
			other,
			notResume,
		])
			expect(existsSync(kept)).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
