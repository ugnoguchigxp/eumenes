import {
	createReadStream,
	existsSync,
	openSync,
	fstatSync,
	closeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

type Entry = Record<string, unknown>;
const severity: Record<string, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
};
const idKeys = [
	"httpRequestId",
	"requestId",
	"runId",
	"jobId",
	"taskId",
	"invocationId",
	"subjectId",
	"utteranceId",
	"sessionId",
	"inferenceId",
	"attemptId",
	"bootId",
];
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const values = new Map<string, string>();
const flags = new Set<string>();
for (let n = 0; n < args.length; n++) {
	const arg = args[n]!;
	if (["--json", "--follow", "--help"].includes(arg)) flags.add(arg);
	else if (
		[
			"--file",
			"--level",
			"--component",
			"--event",
			"--id",
			"--since",
			"--limit",
		].includes(arg) &&
		args[n + 1] &&
		!args[n + 1]!.startsWith("--")
	)
		values.set(arg, args[++n]!);
	else {
		console.error(`Unknown or incomplete option: ${arg}`);
		process.exit(2);
	}
}
if (flags.has("--help")) {
	console.log(
		"bun run logs [--level warn] [--id ID] [--component inference] [--event EVENT] [--since ISO_TIME] [--limit 100] [--json] [--follow] [--file PATH]\nReads api.jsonl and its four rotated backups, oldest first. --level includes higher severities. --id matches any correlation ID exactly. Default: last 100 matching records. --follow prints new records as well.",
	);
	process.exit(0);
}
const file =
	values.get("--file") ??
	(process.env.EUMENES_LOG_FILE ||
		join(
			dirname(process.env.EUMENES_DB ?? "./data/eumenes.sqlite3"),
			"logs/api.jsonl",
		));
const limit = Number(values.get("--limit") ?? 100);
const minimum = values.get("--level") ?? "trace";
const since = values.has("--since") ? Date.parse(values.get("--since")!) : 0;
if (
	!Number.isInteger(limit) ||
	limit < 1 ||
	limit > 10000 ||
	!Object.hasOwn(severity, minimum) ||
	!Number.isFinite(since)
) {
	console.error(
		"Use --limit 1..10000, --level trace|debug|info|warn|error|fatal, and an ISO time for --since.",
	);
	process.exit(2);
}
if (file === "-") {
	console.error(
		"File logging is disabled. Use --file PATH to read an existing log.",
	);
	process.exit(2);
}
const paths = [4, 3, 2, 1, 0].map((n) => (n ? `${file}.${n}` : file));
if (!paths.some(existsSync)) {
	console.error(
		"Log file not found. Start the API first, or select --file PATH.",
	);
	process.exit(1);
}
const offsets = new Map<number, number>();
let invalid = 0;
function matches(entry: Entry) {
	return (
		(severity[String(entry.level)] ?? 0) >= severity[minimum]! &&
		(!since || Date.parse(String(entry.time)) >= since) &&
		(!values.has("--component") ||
			entry.component === values.get("--component")) &&
		(!values.has("--event") || entry.event === values.get("--event")) &&
		(!values.has("--id") ||
			idKeys.some((key) => entry[key] === values.get("--id")))
	);
}
function print(entry: Entry) {
	if (flags.has("--json")) console.log(JSON.stringify(entry));
	else {
		const {
			time,
			level,
			component,
			event,
			service: _service,
			schemaVersion: _schema,
			...fields
		} = entry;
		console.log(
			`${time} ${String(level).toUpperCase()} ${component} ${event} ${JSON.stringify(fields)}`,
		);
	}
}
async function read(emit: (entry: Entry) => void) {
	for (const path of paths) {
		let fd: number;
		try {
			fd = openSync(path, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const info = fstatSync(fd);
		const saved = offsets.get(info.ino) ?? 0;
		const offset = saved > info.size ? 0 : saved;
		if (info.size <= offset) {
			closeSync(fd);
			continue;
		}
		// Only consume complete lines: an interrupted final write is retried later.
		const stream = createReadStream(path, {
			fd,
			autoClose: true,
			start: offset,
			end: info.size - 1,
		});
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		let consumed = offset;
		for await (const line of lines) {
			const bytes = Buffer.byteLength(line) + 1;
			if (consumed + bytes > info.size) break;
			consumed += bytes;
			try {
				const entry: unknown = JSON.parse(line);
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
					invalid++;
					continue;
				}
				if (matches(entry as Entry)) emit(entry as Entry);
			} catch {
				invalid++;
			}
		}
		offsets.set(info.ino, consumed);
	}
}
const recent: Entry[] = [];
await read((entry) => {
	recent.push(entry);
	if (recent.length > limit) recent.shift();
});
recent.forEach(print);
if (invalid) console.error(`Skipped ${invalid} malformed log records.`);
if (flags.has("--follow")) {
	let stopped = false;
	process.on("SIGINT", () => {
		stopped = true;
	});
	process.on("SIGTERM", () => {
		stopped = true;
	});
	while (!stopped) {
		await Bun.sleep(1000);
		await read(print);
	}
}
