import { routerExportSinceSchema } from "../api/domains/toolchain-history/contracts";
import { resolve } from "node:path";
import { createClient } from "../client";
import { cliFailure } from "./failure";

/**
 * How long a request waits for a starting backend, which refuses everything but its status with 503 (spec
 * server-listen-first-startup 2026-11-07 §6). The client sends the same request once more when it is ready.
 */
const STARTING_WAIT_MS = 60_000;
import { submitSchema } from "../api/domains/dialogue/contracts";
import { readApiToken } from "../api/infrastructure/auth-config";
import { commands } from "./commands";
import { USAGE, type CliArgs, type CliIo } from "./commands/types";

const args = process.argv.slice(2);
if (args[0] === "codex-runner") {
	try {
		await (await import("./codex-runner")).codexRunnerCli(args.slice(1));
		process.exit(0);
	} catch {
		console.error(
			"Codex実行の状態を取得・操作できません。独立runnerの起動と接続先を確認してください。",
		);
		process.exit(2);
	}
}
const json = args.includes("--json");
const wait = args.includes("--wait");
const fresh = args.includes("--fresh");
const stable = args.includes("--stable");
const readPages = args.includes("--read-pages");
const errorReport = args.includes("--error-report");
let explicitRequestId: string | undefined;
let conversationId = "main";
let toolchainId: string | undefined;
let listCursor: string | undefined;
let listLimit: number | undefined;
const historyOptions: NonNullable<CliArgs["historyOptions"]> = {};
let exportOut: string | undefined;
let exportSince: string | undefined;
let withEmbeddings = false;
let historyBefore: number | undefined;
let historyAfter: number | undefined;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
	const value = args[i];
	if (value === "--with-embeddings") {
		withEmbeddings = true;
		continue;
	}
	if (value === "--out" || value === "--since") {
		const option = args[++i];
		if (
			!option ||
			option.startsWith("--") ||
			(value === "--since" &&
				!routerExportSinceSchema.safeParse(option).success)
		) {
			console.error(
				"router-export requires --out <dir> and --since ISO date/time with timezone",
			);
			process.exit(2);
		}
		if (value === "--out") exportOut = option;
		else exportSince = new Date(option).toISOString();
		continue;
	}

	if (
		[
			"--json",
			"--wait",
			"--fresh",
			"--stable",
			"--read-pages",
			"--error-report",
		].includes(value ?? "")
	)
		continue;
	if (
		["--from", "--until", "--speaker", "--before", "--after"].includes(
			value ?? "",
		)
	) {
		const option = args[++i];
		if (value === "--before" || value === "--after") {
			const count = Number(option);
			if (!option || !Number.isInteger(count) || count < 0 || count > 9) {
				console.error("history range requires 0..9");
				process.exit(2);
			}
			if (value === "--before") historyBefore = count;
			else historyAfter = count;
		} else if (value === "--speaker") {
			if (option !== "user" && option !== "assistant") {
				console.error("--speaker requires user or assistant");
				process.exit(2);
			}
			historyOptions.speaker = option;
		} else {
			if (!option || !Number.isFinite(Date.parse(option))) {
				console.error("history date requires ISO date/time");
				process.exit(2);
			}
			const date = new Date(
				Date.parse(
					/^(\d{4}-\d{2}-\d{2})$/.test(option)
						? option + "T00:00:00+09:00"
						: option,
				),
			).toISOString();
			if (value === "--from") historyOptions.from = date;
			else historyOptions.until = date;
		}
		continue;
	}
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
	if (value === "--toolchain") {
		toolchainId = args[++i];
		if (
			!toolchainId ||
			!submitSchema.shape.toolchainId.safeParse(toolchainId).success
		) {
			console.error("--toolchain requires a toolchain ID");
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
if (
	command !== "router-export" &&
	(exportOut || exportSince || withEmbeddings)
) {
	console.error(
		"--out, --since and --with-embeddings are router-export options",
	);
	process.exit(2);
}

if (command !== "web" && (fresh || stable || readPages)) {
	console.error("--fresh, --stable and --read-pages are web options");
	process.exit(2);
}
if (errorReport && command !== "run") {
	console.error("--error-report is an option of run");
	process.exit(2);
}
const url = process.env.EUMENES_URL ?? "http://127.0.0.1:8787";
let client: ReturnType<typeof createClient>;
try {
	client = createClient(
		url,
		readApiToken(
			process.env,
			resolve(import.meta.dir, "../data/eumenes.sqlite3"),
		),
		{ startingWaitMs: STARTING_WAIT_MS },
	);
} catch (error) {
	console.error(
		command === "router-export"
			? "router_export_auth_unavailable"
			: error instanceof Error
				? error.message
				: "API auth is not configured",
	);
	console.error("Start the backend once to create the API token.");
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
async function main(): Promise<number> {
	const run =
		command !== undefined && Object.hasOwn(commands, command)
			? commands[command]
			: undefined;
	if (!run) throw new Error(USAGE);
	const cliArgs: CliArgs = {
		command: command!,
		exportOut,
		exportSince,
		withEmbeddings,
		positional,
		json,
		wait,
		fresh,
		stable,
		readPages,
		errorReport,
		explicitRequestId,
		conversationId,
		toolchainId,
		listCursor,
		listLimit,
		historyOptions,
		historyBefore,
		historyAfter,
	};
	const io: CliIo = {
		client,
		show,
		error: (message) => console.error(message),
	};
	return run(cliArgs, io);
}
try {
	process.exitCode = await main();
} catch (error) {
	if (command === "router-export") {
		console.error(
			error instanceof Error && /^router_export_[a-z_]+$/.test(error.message)
				? error.message
				: "router_export_failed (check arguments, output directory and API availability)",
		);
		process.exitCode = 2;
	} else {
		const failure = cliFailure(
			error,
			command === "web" &&
				error instanceof Error &&
				["TimeoutError", "AbortError"].includes(error.name)
				? 4
				: 2,
		);
		for (const line of failure.lines) console.error(line);
		process.exitCode = failure.exitCode;
	}
}
