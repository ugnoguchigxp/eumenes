/**
 * Offline capture of what the Codex app-server puts on the wire through the production host
 * (spec codex-input-cache-structure-2026-11-12 §2.3, §2.5, §6). No model is called: the endpoint is a double that
 * lives in this process on an ephemeral 127.0.0.1 port, and the Codex home is a temporary directory.
 *
 *   bun scripts/codex-wire-capture.ts
 *
 * Prints, for a first call, an `append` and a `reset`, the `input` item sequence and `prompt_cache_key` of each
 * request, then the files Codex leaves in its home before and after the threads are deleted. Exits non-zero when
 * a check fails.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexHost } from "../api/domains/inference";

/** What every response of the double reports as its input. */
const INPUT_TOKENS = 10;

type Captured = { body: any };
const captured: Captured[] = [];
let answers = 0;
const stream = () => {
	const id = `resp_${++answers}`;
	const event = (type: string, data: object) =>
		`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
	return (
		event("response.created", { response: { id } }) +
		event("response.output_item.done", {
			item: {
				type: "message",
				role: "assistant",
				id: `msg_${answers}`,
				content: [{ type: "output_text", text: `answer ${answers}` }],
			},
		}) +
		event("response.completed", {
			response: {
				id,
				usage: {
					input_tokens: INPUT_TOKENS,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 2,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 12,
				},
			},
		})
	);
};
const double = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		if (
			req.method === "POST" &&
			new URL(req.url).pathname.endsWith("/responses")
		) {
			let raw = new Uint8Array(await req.arrayBuffer());
			const encoding = req.headers.get("content-encoding");
			if (encoding === "zstd")
				raw = new Uint8Array(Bun.zstdDecompressSync(raw));
			if (encoding === "gzip") raw = new Uint8Array(Bun.gunzipSync(raw));
			captured.push({ body: JSON.parse(new TextDecoder().decode(raw)) });
			return new Response(stream(), {
				headers: { "content-type": "text/event-stream" },
			});
		}
		return new Response("{}", {
			status: 404,
			headers: { "content-type": "application/json" },
		});
	},
});

const brief = (item: any) =>
	item.type === "message"
		? `${item.role}[${(item.content ?? [])
				.map((part: any) =>
					String(part.text ?? part.type)
						.slice(0, 28)
						.replaceAll("\n", " "),
				)
				.join(" + ")}]`
		: item.type;
const files = async (dir: string) =>
	(await readdir(dir, { recursive: true }).catch(() => []))
		.map(String)
		.filter(
			(name) =>
				!name.startsWith("skills") &&
				!name.endsWith(".sqlite") &&
				!/sqlite-(wal|shm)$/.test(name),
		)
		.sort();
const problems: string[] = [];
const check = (ok: boolean, what: string) => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) problems.push(what);
};

const root = await mkdtemp(join(tmpdir(), "codex-wire-capture-"));
const home = join(root, "codex-home");
// HOME is the temporary directory too: nothing of the person's own Codex is read or written.
const host = createCodexHost({ PATH: process.env.PATH, HOME: root }, { home });
try {
	if (!host) throw new Error("codex is not installed");
	const login = {
		credential: "sk-capture-test",
		baseUrl: `http://127.0.0.1:${double.port}/v1`,
	};
	// The model is whichever the Codex catalog lists first: its head depends on the model, and none is named here.
	const [model] = await host.models(login, AbortSignal.timeout(30_000));
	if (!model) throw new Error("the Codex catalog lists no model");
	const call = (texts: string[], from: (n: number) => string) =>
		host.run(login, {
			model: model.id,
			instructions: "HOST-INSTRUCTIONS",
			messages: texts.map((digest) => ({
				digest,
				assistant: digest.startsWith("assistant"),
			})),
			input: (n) => ({ prompt: from(n), images: [] }),
			reasoningEffort: "high",
			signal: AbortSignal.timeout(90_000),
		});
	const steps: Array<[string, () => Promise<unknown>]> = [
		["first call (new)", () => call(["user-1"], () => "A-TURN-1")],
		[
			"append (the thread holds user-1; the model's answer is not sent again)",
			() => call(["user-1", "assistant-1", "tool-1"], () => "A-TURN-2"),
		],
		["reset (another conversation)", () => call(["user-2"], () => "A-TURN-3")],
	];
	const results: Array<{ inputTokens: number | null }> = [];
	for (const [label, run] of steps) {
		const from = captured.length;
		results.push((await run()) as { inputTokens: number | null });
		console.log(`\n[${label}]`);
		for (const request of captured.slice(from)) {
			console.log(`  prompt_cache_key=${request.body.prompt_cache_key}`);
			console.log(`  reasoning.effort=${request.body.reasoning?.effort}`);
			for (const item of request.body.input) console.log(`    ${brief(item)}`);
		}
	}
	console.log("\n[checks]");
	const [first, append, reset] = captured.map((c) => c.body);
	const text = (body: any) => JSON.stringify(body.input);
	for (const [name, body] of [
		["first", first],
		["append", append],
		["reset", reset],
	] as const)
		for (const block of [
			"<skills_instructions>",
			"<permissions instructions>",
			"<collaboration_mode>",
			"<environment_context>",
			"# AGENTS.md instructions",
		])
			check(!text(body).includes(block), `${name}: no ${block}`);
	check(
		first.prompt_cache_key === append.prompt_cache_key &&
			first.prompt_cache_key === reset.prompt_cache_key,
		"one prompt_cache_key for first, append and reset",
	);
	check(first.reasoning?.effort === "high", "reasoning.effort is named (high)");
	check(
		JSON.stringify(append.input.slice(0, first.input.length)) ===
			JSON.stringify(first.input) &&
			append.input.length === first.input.length + 2,
		"append: the first request, the model's answer, then only the new message",
	);
	// After a revert Codex stamps the items of the head anew (`id`, the turn and time in the metadata); the text is what the cache sees.
	const content = (item: any) =>
		item.type === "message"
			? JSON.stringify([item.role, item.content])
			: JSON.stringify(item);
	check(
		reset.input.slice(0, -1).map(content).join() ===
			first.input.slice(0, -1).map(content).join() &&
			reset.input.length === first.input.length,
		"reset: the same head (ids and stamps aside) and this call's message",
	);
	// Every response of the double reports the same input: a thread total that kept counting through a revert
	// would show as a larger third value.
	console.log(
		`  input tokens recorded per call: ${JSON.stringify(results.map((r) => r.inputTokens))}`,
	);
	check(
		results.every((r) => r.inputTokens === INPUT_TOKENS),
		"usage: each call records what its own turn added (the total restarts after a revert)",
	);
	console.log("\n[Codex home]");
	const before = await files(home);
	console.log(`  files after the three calls: ${JSON.stringify(before)}`);
	check(
		!before.some((name) => name.startsWith("shell_snapshots")),
		"features.shell_snapshot=false: no shell snapshot file",
	);
	check(
		before.some((name) => name.startsWith("sessions")),
		"the thread leaves its record file under the home",
	);
	// Only the fixed working directory is made again.
	const emptied = (names: string[]) => names.every((n) => n === "workspace");
	host.forget();
	for (let i = 0; i < 200; i++) {
		if (emptied(await files(home))) break;
		await Bun.sleep(50);
	}
	const after = await files(home);
	console.log(`  files after forgetting: ${JSON.stringify(after)}`);
	check(
		emptied(after),
		"forgetting stops the processes and empties the home (records and Codex's own databases)",
	);
} finally {
	await host?.close();
	double.stop(true);
	await rm(root, { recursive: true, force: true });
}
if (problems.length) {
	console.error(`\n${problems.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
