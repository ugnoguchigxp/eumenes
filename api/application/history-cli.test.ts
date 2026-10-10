import { test, expect } from "bun:test";
import { harness } from "./toolchain.fixture";
test("history CLI uses authenticated POST API, emits opaque continuation refs, and refuses stale or cross-conversation refs", async () => {
	const h = await harness();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: h.app.fetch,
	});
	async function cli(
		args: string[],
		token = "fixture-token-for-toolchain-browser",
	) {
		const proc = Bun.spawn(
			[process.execPath, "cli/index.ts", ...args, "--json"],
			{
				env: {
					...process.env,
					EUMENES_URL: `http://127.0.0.1:${server.port}`,
					EUMENES_API_TOKEN: token,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, code };
	}
	try {
		await h.conversation.append({
			id: "a",
			conversationId: "main",
			role: "user",
			text: "集合は9時",
			createdAt: "2026-10-10T00:00:00+09:00",
			runId: null,
		});
		await h.conversation.append({
			id: "b",
			conversationId: "main",
			role: "assistant",
			text: "集合は9時です",
			createdAt: "2026-10-10T01:00:00+09:00",
			runId: null,
		});
		const search = await cli([
			"history-search",
			"集合",
			"--limit",
			"1",
			"--from",
			"2026-10-10",
			"--until",
			"2026-10-11",
		]);
		expect(search.code).toBe(0);
		const page = JSON.parse(search.stdout);
		expect(page.candidates[0].messageId).toBe("b");
		expect(page.cursor).toBeTruthy();
		const read = await cli(["history-read", page.candidates[0].messageRef]);
		expect(read.code).toBe(0);
		expect(
			JSON.parse(read.stdout).messages.map(
				(m: { messageId: string }) => m.messageId,
			),
		).toEqual(["a", "b"]);
		expect(
			(
				await cli([
					"history-read",
					page.candidates[0].messageRef,
					"--conversation",
					"other",
				])
			).stderr,
		).toContain("history_ref_invalid");
		expect((await cli(["history-search", "集合"], "invalid-token")).code).toBe(
			2,
		);
		await h.conversation.correct({ messageId: "a", text: "集合は10時" });
		const stale = await cli([
			"history-search",
			"集合",
			"--limit",
			"1",
			"--from",
			"2026-10-10",
			"--until",
			"2026-10-11",
			"--cursor",
			page.cursor,
		]);
		expect(stale.code).toBe(3);
		expect(stale.stderr).toContain("history_cursor_stale");
	} finally {
		server.stop(true);
		await h.close();
	}
});
