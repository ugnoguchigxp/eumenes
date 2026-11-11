import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexTurn } from "../src/codex-turn";

const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0))
		await rm(dir, { recursive: true, force: true });
});

/** A local stand-in for the codex executable: records how it was called, then plays `body`. */
async function fakeCodex(body: string) {
	const dir = await mkdtemp(join(tmpdir(), "codex-turn-"));
	directories.push(dir);
	const command = join(dir, "fake-codex");
	await writeFile(
		command,
		`#!${process.execPath}
import { writeFileSync } from "node:fs";
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(join(dir, "call.json"))}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin, cwd: process.cwd() }));
  const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
${body}
});
`,
		{ mode: 0o700 },
	);
	return {
		dir,
		command,
		call: async () =>
			JSON.parse(await readFile(join(dir, "call.json"), "utf8")),
	};
}
const input = (command: string, extra: object = {}) => ({
	command,
	env: { PATH: process.env.PATH ?? "", ONLY_THIS: "yes" },
	model: "fixture-model",
	reasoning: "low" as const,
	webSearch: "live" as const,
	prompt: "指示\n\n依頼:\n調べる",
	signal: new AbortController().signal,
	...extra,
});

test("one turn answers with the final message, the searches it ran and its tokens, with the options of the reference call", async () => {
	const codex = await fakeCodex(`
  out({ type: "thread.started", thread_id: "t1" });
  out({ type: "turn.started" });
  out({ type: "item.completed", item: { id: "1", type: "web_search", query: "a" } });
  out({ type: "item.completed", item: { id: "2", type: "web_search", query: "b" } });
  out({ type: "item.completed", item: { id: "3", type: "agent_message", text: "題: 答え" } });
  out({ type: "turn.completed", usage: { input_tokens: 25000, cached_input_tokens: 20000, cache_write_input_tokens: 0, output_tokens: 900, reasoning_output_tokens: 300 } });
`);
	const result = await runCodexTurn(
		input(codex.command, {
			config: { features: { shell_tool: false }, project_doc_max_bytes: 0 },
			configOverrides: ["mcp_servers={}"],
		}),
	);
	expect(result).toEqual({
		text: "題: 答え",
		searches: 2,
		usage: { input: 25000, cachedInput: 20000, output: 900, reasoning: 300 },
	});
	const call = await codex.call();
	expect(call.stdin).toBe("指示\n\n依頼:\n調べる");
	const args = call.argv.join(" ");
	expect(args).toContain("--model fixture-model");
	expect(args).toContain('model_reasoning_effort="low"');
	expect(args).toContain('web_search="live"');
	expect(args).toContain("--sandbox read-only");
	expect(args).toContain('approval_policy="never"');
	expect(args).toContain("--skip-git-repo-check");
	expect(args).toContain("features.shell_tool=false");
	expect(args).toContain("mcp_servers={}");
	// Only the environment given reaches the executable, and the directory is private and gone afterwards.
	expect(call.env.ONLY_THIS).toBe("yes");
	expect(call.env.HOME).toBeUndefined();
	const directory = call.argv[call.argv.indexOf("--cd") + 1] as string;
	expect(directory.startsWith(tmpdir())).toBe(true);
	expect(await Bun.file(directory).exists()).toBe(false);
});

test("a failed turn, a missing executable and an abort end the call with an error", async () => {
	const failed = await fakeCodex(`
  out({ type: "turn.failed", error: { message: "boom" } });
`);
	await expect(runCodexTurn(input(failed.command))).rejects.toThrow("boom");
	await expect(
		runCodexTurn(input(join(tmpdir(), "no-such-codex-executable"))),
	).rejects.toThrow();
	const hanging = await fakeCodex(`
  out({ type: "thread.started", thread_id: "t1" });
  setInterval(() => {}, 1000);
`);
	const controller = new AbortController();
	const running = runCodexTurn(
		input(hanging.command, { signal: controller.signal }),
	);
	// Abort once the executable is running (it records its call when it starts).
	while (!(await Bun.file(join(hanging.dir, "call.json")).exists()))
		await Bun.sleep(5);
	controller.abort(new Error("cancelled_by_test"));
	await expect(running).rejects.toThrow();
	await expect(
		runCodexTurn(input(hanging.command, { signal: AbortSignal.abort() })),
	).rejects.toThrow();
}, 15000);
