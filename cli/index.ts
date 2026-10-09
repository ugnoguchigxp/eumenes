import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { ApiError, ApiConnectionError, createClient } from "../client";
import { submitSchema, type Run } from "../api/domains/dialogue/contracts";
import { resolveApiToken } from "../api/infrastructure/auth-config";
import {
	createTaskSchema,
	amendTaskSchema,
	answerTaskSchema,
} from "../api/domains/tasks/contracts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const wait = args.includes("--wait");
const fresh = args.includes("--fresh");
const stable = args.includes("--stable");
const readPages = args.includes("--read-pages");
let explicitRequestId: string | undefined;
let conversationId = "main";
let listCursor: string | undefined;
let listLimit: number | undefined;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
	const value = args[i];
	if (
		["--json", "--wait", "--fresh", "--stable", "--read-pages"].includes(
			value ?? "",
		)
	)
		continue;
	if (value === "--request-id") {
		explicitRequestId = args[++i];
		if (!submitSchema.shape.requestId.safeParse(explicitRequestId).success) {
			console.error("--request-id requires a UUID");
			process.exit(2);
		}
		continue;
	}
	if (value === "--cursor") {
		listCursor = args[++i];
		if (!listCursor) {
			console.error("--cursor requires a value");
			process.exit(2);
		}
		continue;
	}
	if (value === "--limit") {
		listLimit = Number(args[++i]);
		if (!Number.isInteger(listLimit) || listLimit < 1 || listLimit > 50) {
			console.error("--limit requires an integer from 1 to 50");
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
if (command !== "web" && (fresh || stable || readPages)) {
	console.error("--fresh, --stable and --read-pages are web options");
	process.exit(2);
}
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
async function submitTaskCommand<T>(
	requestId: string,
	operation: () => Promise<T>,
) {
	try {
		return await operation();
	} catch (error) {
		console.error(
			`Request ID: ${requestId}. Check task status before retrying.`,
		);
		throw error;
	}
}
async function main() {
	if (command === "tasks") {
		if (wait)
			throw new Error(
				"tasks commands return saved state; --wait is not supported",
			);
		const sub = positional.shift() ?? "list";
		if (sub === "list")
			return show(
				await client.workTasks(positional[0] ? { state: positional[0] } : {}),
			);
		if (sub === "show" && positional[0])
			return show(await client.workTask(positional[0]));
		if (sub === "events" && positional[0])
			return show(
				await client.workTaskEvents(positional[0], positional[1] ?? "0"),
			);
		const requestId = explicitRequestId ?? crypto.randomUUID();
		if (sub === "create" && positional[0]) {
			const body: unknown = await Bun.file(positional[0]).json();
			if (!body || typeof body !== "object" || Array.isArray(body))
				throw new Error("invalid_task_input");
			const parsed = createTaskSchema.safeParse({
				...body,
				requestId:
					explicitRequestId ??
					("requestId" in body ? body.requestId : requestId),
			});
			if (!parsed.success) throw new Error("invalid_task_input");
			return show(
				await submitTaskCommand(parsed.data.requestId, () =>
					client.createTask(parsed.data),
				),
			);
		}
		const [taskId, revisionText] = positional;
		const expectedRevision = Number(revisionText);
		if (
			!taskId ||
			revisionText === undefined ||
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0
		)
			throw new Error(
				"usage: tasks list [state]|show <id>|events <id> [cursor]|create <json>|start <id> <revision>|stop <id> <revision> <pause|cancel>|answer <id> <revision> <questionId> <answer>|amend <id> <revision> <grant-json>|forget <id> <revision>",
			);
		if (sub === "forget")
			return show(
				await submitTaskCommand(requestId, () =>
					client.forgetTask(taskId, requestId, expectedRevision),
				),
			);
		if (sub === "start")
			return show(
				await submitTaskCommand(requestId, () =>
					client.startTask(taskId, requestId, expectedRevision),
				),
			);
		if (
			sub === "stop" &&
			(positional[2] === "pause" || positional[2] === "cancel")
		)
			return show(
				await submitTaskCommand(requestId, () =>
					client.stopTask(
						taskId,
						requestId,
						expectedRevision,
						positional[2] as "pause" | "cancel",
					),
				),
			);
		if (sub === "answer") {
			const parsed = answerTaskSchema.safeParse({
				requestId,
				expectedRevision,
				questionId: positional[2],
				answer: positional.slice(3).join(" "),
			});
			if (!parsed.success) throw new Error("invalid_task_input");
			return show(
				await submitTaskCommand(requestId, () =>
					client.answerTask(taskId, parsed.data),
				),
			);
		}
		if (sub === "amend" && positional[2]) {
			const parsed = amendTaskSchema.safeParse({
				requestId,
				expectedRevision,
				grant: await Bun.file(positional[2]).json(),
			});
			if (!parsed.success) throw new Error("invalid_task_input");
			return show(
				await submitTaskCommand(requestId, () =>
					client.amendTask(taskId, parsed.data),
				),
			);
		}
		throw new Error("invalid_tasks_command");
	}
	if (command === "web") {
		const sub = positional.shift();
		if ((stable || fresh) && sub !== "read")
			throw new Error("--stable and --fresh require web read");
		if (readPages && sub !== "search")
			throw new Error("--read-pages requires web search");
		if (sub === "cache") return show(await client.researchCacheStatus());
		if (sub === "clear") return show(await client.clearResearchCache());
		if (sub === "run" && positional[0])
			return show(await client.researchRun(positional[0]));
		if (sub === "cancel" && positional[0])
			return show(await client.cancelResearch(positional[0]));
		if (sub !== "search" && sub !== "read")
			throw new Error(
				"usage: web search <query>|read <url>|run <id>|cancel <id>|cache|clear [--wait] [--fresh] [--stable] [--read-pages]",
			);
		const value = positional.join(" ").trim();
		if (!value) throw new Error("query or URL required");
		const requestId = explicitRequestId ?? crypto.randomUUID();
		const run = await client.submitResearch(
			sub === "read"
				? {
						requestId,
						operation: "read",
						url: value,
						retention: stable ? "stable" : "none",
						freshness: fresh || !stable ? "live" : "normal",
					}
				: {
						requestId,
						operation: "lookup",
						query: value,
						readPages: readPages ? 3 : 0,
						freshness: "live",
					},
		);
		if (!wait) return show(run);
		let cancelled = false;
		const polling = new AbortController();
		const waitSignal = AbortSignal.any([
			polling.signal,
			AbortSignal.timeout(40000),
		]);
		const abort = () => {
			cancelled = true;
			polling.abort();
			void client
				.cancelResearch(run.id, AbortSignal.timeout(1000))
				.catch(() => {});
		};
		process.once("SIGINT", abort);
		try {
			const deadline = Date.now() + 40000;
			while (Date.now() < deadline) {
				const current = await client.researchRun(run.id, waitSignal);
				if (!["queued", "running"].includes(current.status)) {
					show(current);
					process.exitCode =
						current.status === "cancelled" || current.resultExpired
							? 4
							: ["completed", "partial"].includes(current.status)
								? 0
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
				await Bun.sleep(250);
			}
			await client
				.cancelResearch(run.id, AbortSignal.timeout(1000))
				.catch(() => {});
			console.error(
				`run ${run.id}: web research timed out; cancellation requested; outcome unconfirmed`,
			);
			process.exitCode = 4;
			return;
		} catch (error) {
			if (
				cancelled ||
				waitSignal.aborted ||
				(error instanceof Error &&
					["TimeoutError", "AbortError"].includes(error.name))
			) {
				if (!cancelled)
					void client
						.cancelResearch(run.id, AbortSignal.timeout(1000))
						.catch(() => {});
				console.error(
					`run ${run.id}: wait interrupted; cancellation requested; outcome unconfirmed`,
				);
				process.exitCode = 4;
				return;
			}
			throw error;
		} finally {
			process.removeListener("SIGINT", abort);
		}
	}
	if (command === "collection") {
		const sub = positional.shift() ?? "status";
		if (sub === "start") return show(await client.attitudeStart());
		if (sub === "stop") return show(await client.attitudeStop());
		if (sub === "status") return show(await client.attitudeStatus());
		if (sub === "list") return show(await client.attitudeSamples());
		if (sub === "report") return show(await client.attitudeReport());
		if (sub === "split") return show(await client.attitudeSplit());
		if (sub === "show" && positional[0])
			return show(
				await client.attitudeSample(
					positional[0],
					positional[1] === "predictions",
				),
			);
		if (sub === "prepare" && positional[0] && positional[1]) {
			const sample = (await client.attitudeSample(
				positional[0],
			)) as import("../api/domains/attitude-dataset/contracts").Sample;
			const draft = {
				revision: sample.revision,
				primary_label: sample.primary_label,
				acceptable_labels: sample.acceptable_labels,
				expression_transition: sample.expression_transition,
				review_status: sample.review_status,
				correction_reason: sample.correction_reason,
				template_group_id: sample.template_group_id,
				template_group_confirmed: sample.template_group_confirmed,
				coverage_tags: sample.coverage_tags,
			};
			const file = resolve(positional[1]);
			await writeFile(file, JSON.stringify(draft, null, 2) + "\n", {
				mode: 0o600,
				flag: "wx",
			});
			return show({ file });
		}
		if (sub === "review" && positional[0] && positional[1])
			return show(
				await client.attitudeReview(
					positional[0],
					await Bun.file(positional[1]).json(),
				),
			);
		if (sub === "export" && positional[0]) {
			const bundle = await client.attitudeExport();
			const directory = resolve(positional[0]);
			await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
			// Claim a fresh directory before writing any part of the export.
			await mkdir(directory, { mode: 0o700 });
			for (const [name, contents] of [
				["reviewed.jsonl", bundle.jsonl],
				["train.jsonl", bundle.partitions.train],
				["calibration.jsonl", bundle.partitions.calibration],
				["eval.jsonl", bundle.partitions.eval],
				["report.json", JSON.stringify(bundle.report, null, 2)],
				["schema.json", JSON.stringify(bundle.schema, null, 2)],
			])
				await writeFile(join(directory, name!), contents!, {
					mode: 0o600,
					flag: "wx",
				});
			return show({ directory });
		}
		throw new Error(
			"usage: collection status|start|stop|list|show <id> [predictions]|prepare <id> <private-file>|review <id> <review.json>|report|split|export <private-directory>",
		);
	}
	if (command === "capabilities") return show(await client.capabilities());
	if (command === "task" && positional[0])
		return show(await client.agentTask(positional[0]));
	if (command === "task-report" && positional[0])
		return show(await client.agentReport(positional[0]));
	if (command === "task-cancel" && positional[0])
		return show(await client.cancelAgentTask(positional[0]));
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
	if (command === "research-routes") {
		const sub = positional.shift();
		const usage =
			"usage: research-routes list [--cursor C] [--limit 1-50]|show <key>|edit <key> <stateToken> <instruction-file>|disable <key> <stateToken>|rediscover <key> <stateToken>|clear <expectedEpoch> [--request-id UUID]";
		const requestId = explicitRequestId ?? crypto.randomUUID();
		// Mutations surface the request ID on failure so an identical retry stays idempotent.
		const mutate = async <T>(operation: () => Promise<T>) => {
			try {
				return await operation();
			} catch (error) {
				console.error(
					`Request ID: ${requestId}. Retry with --request-id ${requestId} to repeat the same request.`,
				);
				throw error;
			}
		};
		if (sub === "list") {
			return show(
				await client.researchRoutes({
					...(listCursor ? { cursor: listCursor } : {}),
					...(listLimit ? { limit: listLimit } : {}),
				}),
			);
		}
		const [key, token, file] = positional;
		if (sub === "show" && key) return show(await client.researchRoute(key));
		if (sub === "edit" && key && token && file) {
			// The instruction comes from a file so the text never passes through a shell line.
			const instruction = (await readFile(file, "utf8")).trim();
			return show(
				await mutate(() =>
					client.editResearchRoute(key, {
						requestId,
						expectedStateToken: token,
						instruction,
					}),
				),
			);
		}
		if (sub === "disable" && key && token)
			return show(
				await mutate(() =>
					client.disableResearchRoute(key, {
						requestId,
						expectedStateToken: token,
					}),
				),
			);
		if (sub === "rediscover" && key && token)
			return show(
				await mutate(() =>
					client.rediscoverResearchRoute(key, {
						requestId,
						expectedStateToken: token,
					}),
				),
			);
		if (sub === "clear" && key !== undefined && /^\d+$/.test(key))
			return show(
				await mutate(() =>
					client.clearResearchRoutes({
						requestId,
						expectedEpoch: Number(key),
					}),
				),
			);
		throw new Error(usage);
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
		"usage: bun cli/index.ts status|web search|web read|web run|web cancel|web cache|web clear|research-routes ...|memory ...|send [text] [--wait] [--json] [--request-id UUID]|history [id]|run <id>|cancel <id>",
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
		process.exitCode =
			command === "web" &&
			error instanceof Error &&
			["TimeoutError", "AbortError"].includes(error.name)
				? 4
				: 2;
	}
}
