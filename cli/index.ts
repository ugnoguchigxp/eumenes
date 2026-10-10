import { ApiError, ApiConnectionError, createClient } from "../client";
import { submitSchema } from "../api/domains/dialogue/contracts";
import { resolveApiToken } from "../api/infrastructure/auth-config";
import { commands } from "./commands";
import { USAGE, type CliArgs, type CliIo } from "./commands/types";

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
const historyOptions: NonNullable<CliArgs["historyOptions"]> = {};
let historyBefore: number | undefined;
let historyAfter: number | undefined;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
	const value = args[i];
	if (
		["--json", "--wait", "--fresh", "--stable", "--read-pages"].includes(
			value ?? "",
		)
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
async function main(): Promise<number> {
	const run =
		command !== undefined && Object.hasOwn(commands, command)
			? commands[command]
			: undefined;
	if (!run) throw new Error(USAGE);
	const cliArgs: CliArgs = {
		command: command!,
		positional,
		json,
		wait,
		fresh,
		stable,
		readPages,
		explicitRequestId,
		conversationId,
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
