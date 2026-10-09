import { ApiError, ApiConnectionError, createClient } from "../client";
import { submitSchema, type Run } from "../api/domains/dialogue/contracts";
import { resolveApiToken } from "../api/infrastructure/auth-config";

const args = process.argv.slice(2);
const json = args.includes("--json");
const wait = args.includes("--wait");
let explicitRequestId: string | undefined;
let conversationId = "main";
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
	const value = args[i];
	if (value === "--json" || value === "--wait") continue;
	if (value === "--request-id") {
		explicitRequestId = args[++i];
		if (!submitSchema.shape.requestId.safeParse(explicitRequestId).success) {
			console.error("--request-id requires a UUID");
			process.exit(2);
		}
		continue;
	}
	if (value === "--conversation") {
		conversationId = args[++i] ?? "";
		if (!conversationId) {
			console.error("--conversation requires an ID");
			process.exit(2);
		}
		continue;
	}
	if (!value || value.startsWith("--")) {
		console.error(`Unknown option: ${value}`);
		process.exit(2);
	}
	positional.push(value);
}
const command = positional.shift();
const url = process.env.EUMENES_URL ?? "http://127.0.0.1:8787";
let client: ReturnType<typeof createClient>;
try {
	client = createClient(url, resolveApiToken(process.env));
} catch (error) {
	console.error(
		error instanceof Error ? error.message : "API auth is not configured",
	);
	process.exit(2);
}
function show(value: unknown) {
	console.log(
		json
			? JSON.stringify(value)
			: typeof value === "string"
				? value
				: JSON.stringify(value, null, 2),
	);
}
async function main() {
	if (command === "status") return show(await client.status());
	if (command === "history")
		return show(await client.conversation(positional[0] ?? conversationId));
	if (command === "run") {
		if (!positional[0]) throw new Error("run ID required");
		return show(await client.run(positional[0]));
	}
	if (command === "cancel") {
		if (!positional[0]) throw new Error("run ID required");
		return show(await client.cancel(positional[0]));
	}
	if (command === "send") {
		const content = positional.join(" ") || (await Bun.stdin.text());
		if (!content.trim()) throw new Error("message required");
		const requestId = explicitRequestId ?? crypto.randomUUID();
		let run: Run;
		try {
			run = await client.submit({
				requestId,
				conversationId,
				text: content.trim(),
			});
		} catch (error) {
			console.error(`Request ID: ${requestId}. Check status before retrying.`);
			throw error;
		}
		if (!wait) return show(run);
		let cancelled = false;
		const onSignal = () => {
			cancelled = true;
			void client.cancel(run.id).catch(() => {});
		};
		process.once("SIGINT", onSignal);
		try {
			// Wait until the run's own deadline (queue wait + inference) plus a short margin.
			const waitUntil =
				(run.deadlineAt ? Date.parse(run.deadlineAt) : Date.now() + 180_000) +
				10_000;
			while (Date.now() < waitUntil) {
				const current = await client.run(run.id);
				if (!["queued", "running"].includes(current.status)) {
					show(current);
					process.exitCode =
						current.status === "completed"
							? 0
							: current.status === "cancelled"
								? 4
								: 3;
					return;
				}
				if (cancelled) {
					console.error(
						`run ${run.id}: cancellation requested; outcome unconfirmed`,
					);
					process.exitCode = 4;
					return;
				}
				await Bun.sleep(500);
			}
			await client.cancel(run.id).catch(() => {});
			console.error(
				`run ${run.id}: timeout; cancellation requested, outcome unconfirmed`,
			);
			process.exitCode = 4;
		} finally {
			process.removeListener("SIGINT", onSignal);
		}
		return;
	}
	if (command === "memory") {
		const sub = positional.shift();
		if (!sub || sub === "list") return show(await client.memoryItems(false));
		if (sub === "all") return show(await client.memoryItems(true));
		if (sub === "status") return show(await client.memoryStatus());
		if (sub === "on" || sub === "off")
			return show(await client.setMemoryEnabled(sub === "on"));
		if (sub === "remember") {
			// remember <messageId> <semanticKey> <kind> <quote> [text]
			const [messageId, semanticKey, kind, quote, ...rest] = positional;
			if (!messageId || !semanticKey || !kind || !quote)
				throw new Error(
					"usage: memory remember <messageId> <semanticKey> <preference|personal_fact|constraint|habit> <quote> [text]",
				);
			return show(
				await client.rememberItem({
					conversationId,
					messageId,
					semanticKey,
					kind: kind as "preference",
					quote,
					text: rest.join(" ") || quote,
				}),
			);
		}
		if (sub === "forget") {
			if (!positional[0]) throw new Error("item ID required");
			return show(await client.forgetItem(positional[0]));
		}
		if (sub === "stop" || sub === "resume" || sub === "retract") {
			const revision = Number(positional[1]);
			if (!positional[0] || !Number.isInteger(revision))
				throw new Error(`usage: memory ${sub} <itemId> <revision>`);
			return show(await client.memoryAction(positional[0], sub, revision));
		}
		throw new Error(
			"usage: memory list|all|status|on|off|remember|stop|resume|retract|forget",
		);
	}
	throw new Error(
		"usage: bun cli/index.ts status|memory ...|send [text] [--wait] [--json] [--request-id UUID]|history [id]|run <id>|cancel <id>",
	);
}
try {
	await main();
} catch (error) {
	if (error instanceof ApiError) {
		console.error(error.message);
		if (error.requestId) console.error(`API request ID: ${error.requestId}`);
		process.exitCode = error.status === 401 ? 2 : 3;
	} else if (error instanceof ApiConnectionError) {
		console.error(
			`Cannot connect to ${url}. Start backend with bun run start.`,
		);
		process.exitCode = 5;
	} else {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
