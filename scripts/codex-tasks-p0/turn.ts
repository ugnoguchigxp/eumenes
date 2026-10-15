import { probeClient } from "./runtime";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

const [directory, workspace, mode] = process.argv.slice(2);
if (!directory || !workspace || !mode)
	throw new Error("probe_arguments_missing");
const sources = [
	"runtime.ts",
	"transport.ts",
	"turn.ts",
	...[
		"sdk-transport.ts",
		"sdk-process-tree.ts",
		"storage.ts",
		"contracts.ts",
	].map((file) => `../../packages/coding-runner/src/${file}`),
];
async function fingerprints() {
	return Promise.all(
		sources.map(async (file) =>
			new Bun.CryptoHasher("sha256")
				.update(await readFile(new URL(file, import.meta.url)))
				.digest("hex"),
		),
	);
}
const initialSources = await fingerprints();
const codex = await probeClient(
	directory,
	workspace,
	mode === "git" || mode === "push",
	mode === "push" ? join(dirname(workspace), "remote.git") : undefined,
);
const options = {
	workingDirectory: workspace,
	approvalPolicy: "never" as const,
	webSearchMode: "disabled" as const,
};
const saved =
	mode === "resume" || mode === "git" || mode === "push"
		? JSON.parse(await readFile(join(directory, "previous.json"), "utf8"))
		: undefined;
const thread = saved
	? codex.resumeThread(saved.threadId, options)
	: codex.startThread(options);
const prompt = await readFile(join(directory, "input.txt"), "utf8");
const outputSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		outcome: { type: "string", enum: ["done", "blocked"] },
		marker: { type: "string" },
		summary: { type: "string" },
	},
	required: ["outcome", "marker", "summary"],
};
const events: Array<{
	type: string;
	itemType?: string;
	itemId?: string;
	exitCode?: number;
	outputBytes?: number;
}> = [];
let finalResponse = "";
let failure: string | undefined;
const started = performance.now();
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 180_000);
const abortWatcher = setInterval(() => {
	if (existsSync(join(directory, "abort"))) controller.abort();
}, 100);
try {
	const streamed = await thread.runStreamed(prompt, {
		outputSchema,
		signal: controller.signal,
	});
	for await (const event of streamed.events) {
		events.push({
			type: event.type,
			...("item" in event
				? {
						itemType: event.item.type,
						itemId: event.item.id,
						...(event.item.type === "command_execution"
							? {
									exitCode: event.item.exit_code,
									outputBytes: Buffer.byteLength(event.item.aggregated_output),
								}
							: {}),
					}
				: {}),
		});
		if (event.type === "item.completed" && event.item.type === "agent_message")
			finalResponse = event.item.text;
		if (event.type === "error") failure = "sdk_event_error";
		if (event.type === "turn.failed") failure = "sdk_turn_failed";
	}
} catch {
	failure = controller.signal.aborted ? "sdk_aborted" : "sdk_exec_failed";
} finally {
	clearTimeout(timeout);
	clearInterval(abortWatcher);
}
// Isolated fixture output only; no provider response, credentials or product settings.
const sourceStable =
	JSON.stringify(initialSources) === JSON.stringify(await fingerprints());
await writeFile(
	join(directory, "result.json"),
	JSON.stringify(
		{
			threadId: thread.id,
			events,
			finalResponse,
			failure,
			sourceStable,
			durationMs: performance.now() - started,
		},
		null,
		2,
	),
	{ mode: 0o600 },
);
console.log(
	JSON.stringify({
		threadId: thread.id,
		eventTypes: events.map((e) => e.type),
		failure,
		durationMs: performance.now() - started,
	}),
);
if (
	!sourceStable ||
	failure ||
	!events.some((e) => e.type === "turn.completed")
)
	process.exitCode = 1;
