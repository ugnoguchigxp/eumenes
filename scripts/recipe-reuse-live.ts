/** Real worker decisions, fixture Web pages and isolated persistence; no server is started. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	harness,
	workerPacket,
} from "../api/application/toolchain/toolchain.fixture";
import { createLiveLarm } from "./live-larm";

if (!process.argv.includes("--run"))
	throw new Error("Pass --run to use the saved LARM connection");
const live = createLiveLarm();
let turn = 0;
const decisions: Array<{
	turn: number;
	action?: string;
	tool?: string;
	arguments?: unknown;
	candidates?: unknown;
}> = [];
const acquisitions: Array<{ turn: number; operation: string; url?: string }> =
	[];
const url = "https://example.com/weather";
const h = await harness({
	control: async (messages) => {
		const raw = await live.answer(messages, AbortSignal.timeout(45000), {
			jsonOutput: true,
			sessionRole: "subagent",
			taskId: `recipe-reuse-${turn}`,
		});
		try {
			const value = JSON.parse(raw);
			decisions.push({
				turn,
				action: value.action,
				tool: value.tool,
				arguments: value.arguments,
				candidates: workerPacket(messages).candidates,
			});
		} catch {
			decisions.push({ turn });
		}
		return raw;
	},
	acquire: async (request) => {
		acquisitions.push({
			turn,
			operation: request.operation,
			...(request.operation === "read" ? { url: request.url } : {}),
		});
		const at = new Date().toISOString();
		return {
			freshUntilMs: null,
			result: {
				provider: "llm-fetch@0.1.4",
				observedAt: at,
				cache: "bypass",
				hits:
					request.operation === "lookup"
						? [
								{
									url,
									title: "鎌倉市の天気",
									snippet: "今日の天気と気温",
									provider: "fixture",
									trust: "untrusted",
									tainted: true,
									verification: "search_summary",
								},
							]
						: [],
				documents:
					request.operation === "read"
						? [
								{
									url,
									title: "鎌倉市の天気",
									text: `鎌倉市の今日の天気は晴れ、最高気温は${turn === 1 ? 25 : 23}℃、最低気温は15℃です。発表日時は${at}です。`,
									fetchedAt: at,
									truncated: false,
									trust: "untrusted",
									tainted: true,
									verification: "source_read",
									guardDecision: "allow",
									guardReasonCodes: [],
								},
							]
						: [],
				failures: [],
			},
		};
	},
});
const results: object[] = [];
try {
	await live.connect();
	for (turn = 1; turn <= 2; turn++) {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "recipe-live",
			text: "鎌倉の今日の天気と最高気温を教えて",
		});
		const done = await h.dialogue.waitForTerminal(run.id, {
			timeoutMs: 160000,
		});
		const task = h.toolchain.agents
			.list(run.id)
			.find((t) => t.kind === "worker");
		const report =
			task?.status === "completed" ? h.toolchain.agents.report(task.id) : null;
		const selection = h.toolchain.history.getSelection(run.id);
		const facts = report?.claims.map((c) => c.text).join(" ") ?? "";
		const result = {
			turn,
			status: done?.status,
			outcome: report?.outcome,
			recipe: selection?.recipe,
			facts,
			saved: h.toolchain.history.listRecipes("web.search").length,
		};
		results.push(result);
		console.log(JSON.stringify(result));
		if (report?.outcome !== "answered" || result.saved === 0) break;
	}
} finally {
	await h.close();
	await live.close();
}
const first = decisions
	.filter((d) => d.turn === 1 && d.action === "invoke")
	.map((d) => d.tool);
const second = decisions
	.filter((d) => d.turn === 2 && d.action === "invoke")
	.map((d) => d.tool);
const passed =
	JSON.stringify(first) ===
		JSON.stringify(["recipe.find", "web.lookup", "web.read"]) &&
	JSON.stringify(second) === JSON.stringify(["recipe.find", "web.read"]) &&
	acquisitions
		.filter((a) => a.turn === 2)
		.every((a) => a.operation === "read" && a.url === url) &&
	(results[1] as { facts: string } | undefined)?.facts.includes("23") === true;
const directory = resolve(
	"verification-reports/recipe-reuse",
	new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(
	resolve(directory, "result.json"),
	JSON.stringify(
		{
			passed,
			note: "Real worker model, fixture acquisition and conversation model; not a live Web or device test.",
			results,
			decisions,
			acquisitions,
		},
		null,
		2,
	) + "\n",
	{ mode: 0o600 },
);
console.log(JSON.stringify({ passed, first, second }));
if (!passed) process.exitCode = 1;
