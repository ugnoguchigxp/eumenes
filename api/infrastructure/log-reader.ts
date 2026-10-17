import { closeSync, createReadStream, fstatSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

/** One parsed JSONL record of the operational log. */
export type LogEntry = Record<string, unknown>;

/**
 * The instant of a record (epoch ms; NaN when missing or invalid). Records are JST with an offset, and
 * records written before that were UTC (`Z`): compare instants, never the `time` text.
 */
export function logTimeMs(entry: LogEntry): number {
	return Date.parse(String(entry.time));
}

export const LOG_SEVERITY: Readonly<Record<string, number>> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
};
/** The correlation IDs a record can carry (`docs/logging.md`); `--id` and `readLogEntries` match these only. */
export const LOG_ID_KEYS = [
	"httpRequestId",
	"requestId",
	"runId",
	"jobId",
	"taskId",
	"workTaskId",
	"invocationId",
	"operationId",
	"subjectId",
	"utteranceId",
	"sessionId",
	"inferenceId",
	"attemptId",
	"stepId",
	"bootId",
] as const;

/** The log file the backend writes by default; undefined when the file log is disabled (`EUMENES_LOG_FILE=-`). */
export function defaultLogFile(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	// Same rules as the backend's config: a blank value counts as unset.
	const set = (value: string | undefined) => value?.trim() || undefined;
	const logFile = set(env.EUMENES_LOG_FILE);
	if (logFile === "-") return undefined;
	return (
		logFile ??
		join(
			dirname(set(env.EUMENES_DB) ?? "./data/eumenes.sqlite3"),
			"logs/api.jsonl",
		)
	);
}

/** The current file and its four rotated generations, oldest first. */
export function logGenerations(file: string): string[] {
	return [4, 3, 2, 1, 0].map((n) => (n ? `${file}.${n}` : file));
}

/**
 * A reader of the log file and its rotated generations. It remembers how far each file was consumed (by
 * inode), so a later `read` returns only the new complete lines; an interrupted final write is left for
 * the next call.
 */
export function createLogReader(file: string) {
	const offsets = new Map<number, number>();
	let invalid = 0;
	return {
		/** Records that were not valid JSON objects, over all reads so far. */
		get invalid() {
			return invalid;
		},
		/**
		 * Emits each record in file order, oldest generation first. `contains` skips a line before it is
		 * parsed when it does not match, so a lookup by ID does not parse the whole log.
		 */
		async read(emit: (entry: LogEntry) => void, contains?: RegExp) {
			for (const path of logGenerations(file)) {
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
					if (contains && !contains.test(line)) continue;
					try {
						const entry: unknown = JSON.parse(line);
						if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
							invalid++;
							continue;
						}
						emit(entry as LogEntry);
					} catch {
						invalid++;
					}
				}
				offsets.set(info.ino, consumed);
			}
		},
	};
}

/**
 * Every record in which one of the correlation IDs equals one of `ids`, in time order (equal times keep
 * the file order). A missing log yields no records.
 */
export async function readLogEntries(
	file: string,
	ids: Iterable<string>,
): Promise<LogEntry[]> {
	const wanted = new Set(ids);
	if (!wanted.size) return [];
	const pattern = new RegExp(
		[...wanted]
			.map((id) => id.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&"))
			.join("|"),
	);
	const found: LogEntry[] = [];
	await createLogReader(file).read((entry) => {
		if (LOG_ID_KEYS.some((key) => wanted.has(entry[key] as string)))
			found.push(entry);
	}, pattern);
	return found
		.map((entry, order) => ({ entry, order }))
		.sort(
			(a, b) => logTimeMs(a.entry) - logTimeMs(b.entry) || a.order - b.order,
		)
		.map(({ entry }) => entry);
}
