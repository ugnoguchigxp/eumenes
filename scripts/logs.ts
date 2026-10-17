import { existsSync } from "node:fs";
import {
	LOG_ID_KEYS,
	LOG_SEVERITY,
	createLogReader,
	defaultLogFile,
	logGenerations,
	logTimeMs,
	type LogEntry as Entry,
} from "../api/infrastructure/log-reader";
import { jstIso, parseTimeJst } from "../api/infrastructure/jst-time";

const severity = LOG_SEVERITY;
const idKeys = LOG_ID_KEYS;
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
		"bun run logs [--level warn] [--id ID] [--component inference] [--event EVENT] [--since TIME] [--limit 100] [--json] [--follow] [--file PATH]\nReads api.jsonl and its four rotated backups, oldest first. --level includes higher severities. --id matches any correlation ID exactly. --since takes an ISO 8601 time; without a zone it is JST. Times are shown in JST (+09:00); --json prints the stored record. Default: last 100 matching records. --follow prints new records as well.",
	);
	process.exit(0);
}
const file = values.get("--file") ?? defaultLogFile() ?? "-";
const limit = Number(values.get("--limit") ?? 100);
const minimum = values.get("--level") ?? "trace";
const since = values.has("--since") ? parseTimeJst(values.get("--since")!) : 0;
if (
	!Number.isInteger(limit) ||
	limit < 1 ||
	limit > 10000 ||
	!Object.hasOwn(severity, minimum) ||
	!Number.isFinite(since)
) {
	console.error(
		"Use --limit 1..10000, --level trace|debug|info|warn|error|fatal, and an ISO time (JST unless it has a zone) for --since.",
	);
	process.exit(2);
}
if (file === "-") {
	console.error(
		"File logging is disabled. Use --file PATH to read an existing log.",
	);
	process.exit(2);
}
if (!logGenerations(file).some(existsSync)) {
	console.error(
		"Log file not found. Start the API first, or select --file PATH.",
	);
	process.exit(1);
}
const reader = createLogReader(file);
function matches(entry: Entry) {
	return (
		(severity[String(entry.level)] ?? 0) >= severity[minimum]! &&
		(!since || logTimeMs(entry) >= since) &&
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
		const instant = logTimeMs(entry);
		console.log(
			`${Number.isFinite(instant) ? jstIso(instant) : String(time)} ${String(level).toUpperCase()} ${component} ${event} ${JSON.stringify(fields)}`,
		);
	}
}
const recent: Entry[] = [];
await reader.read((entry) => {
	if (!matches(entry)) return;
	recent.push(entry);
	if (recent.length > limit) recent.shift();
});
recent.forEach(print);
if (reader.invalid)
	console.error(`Skipped ${reader.invalid} malformed log records.`);
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
		await reader.read((entry) => {
			if (matches(entry)) print(entry);
		});
	}
}
