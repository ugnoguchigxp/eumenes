import { AsyncLocalStorage } from "node:async_hooks";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname } from "node:path";
import pino, { type DestinationStream, type LevelWithSilent } from "pino";

// Only operational metadata crosses this boundary. Never pass request bodies,
// settings, provider responses, credentials, or raw Error objects to Pino.
export interface LogFields {
	httpRequestId?: string;
	requestId?: string;
	runId?: string;
	jobId?: string;
	timerId?: string;
	operationId?: string;
	notificationId?: string;
	taskId?: string;
	workTaskId?: string;
	invocationId?: string;
	subjectId?: string;
	utteranceId?: string;
	sessionId?: string;
	inferenceId?: string;
	attemptId?: string;
	stepId?: string;
	phase?: string;
	controlSchema?: string;
	controlAction?: string;
	outputType?: string;
	outputCharacters?: number;
	repairAttempt?: number;
	validationPath?: string;
	validationCode?: string;
	expectedType?: string;
	actualType?: string;
	issueCount?: number;
	reportedIssueCount?: number;
	limit?: number;
	jsonOffset?: number;
	hitCount?: number;
	documentCount?: number;
	failureCount?: number;
	method?: string;
	route?: string;
	status?: string | number;
	purpose?: string;
	source?: string;
	reason?: string;
	kind?: string;
	durationMs?: number;
	bytes?: number;
	count?: number;
	attempt?: number;
	generation?: number;
	port?: number;
}
const keys = new Set<keyof LogFields>([
	"httpRequestId",
	"requestId",
	"runId",
	"jobId",
	"timerId",
	"operationId",
	"notificationId",
	"taskId",
	"workTaskId",
	"invocationId",
	"subjectId",
	"utteranceId",
	"sessionId",
	"inferenceId",
	"attemptId",
	"stepId",
	"phase",
	"controlSchema",
	"controlAction",
	"outputType",
	"outputCharacters",
	"repairAttempt",
	"validationPath",
	"validationCode",
	"expectedType",
	"actualType",
	"issueCount",
	"reportedIssueCount",
	"limit",
	"jsonOffset",
	"hitCount",
	"documentCount",
	"failureCount",
	"method",
	"route",
	"status",
	"purpose",
	"source",
	"reason",
	"kind",
	"durationMs",
	"bytes",
	"count",
	"attempt",
	"generation",
	"port",
]);
const scope = new AsyncLocalStorage<LogFields>();
const bootId = crypto.randomUUID();

/** Bounded, synchronous writes preserve the final record on process exit. */
export function rotatingLogFile(
	path: string,
	maxBytes = 10 * 1024 * 1024,
	backups = 4,
): DestinationStream {
	let failed = false;
	let size = 0;
	function warning() {
		if (failed) return;
		failed = true;
		process.stderr.write(
			JSON.stringify({
				time: new Date().toISOString(),
				level: "error",
				event: "logging.file_unavailable",
				component: "logger",
				service: "eumenes",
				pid: process.pid,
				bootId,
				schemaVersion: 1,
			}) + "\n",
		);
	}
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		appendFileSync(path, "", { mode: 0o600 });
		chmodSync(path, 0o600);
		size = statSync(path).size;
	} catch {
		warning();
	}
	return {
		write(line) {
			if (failed) return;
			try {
				const bytes = Buffer.byteLength(line);
				if (size && size + bytes > maxBytes) {
					rmSync(`${path}.${backups}`, { force: true });
					for (let n = backups - 1; n >= 1; n--)
						if (existsSync(`${path}.${n}`))
							renameSync(`${path}.${n}`, `${path}.${n + 1}`);
					renameSync(path, `${path}.1`);
					size = 0;
				}
				appendFileSync(path, line, { mode: 0o600 });
				size += bytes;
			} catch {
				warning();
			}
		},
	};
}

export function createLogWriter(
	destination: DestinationStream,
	level: LevelWithSilent = "info",
) {
	return pino(
		{
			level,
			base: { service: "eumenes", pid: process.pid, bootId, schemaVersion: 1 },
			timestamp: pino.stdTimeFunctions.isoTime,
			formatters: { level: (label) => ({ level: label }) },
		},
		destination,
	);
}
let writer = createLogWriter(
	process.stderr,
	process.env.NODE_ENV === "test" ? "silent" : "info",
);

export function configureLogging(options: {
	file?: string;
	level?: string;
	destination?: DestinationStream;
}) {
	const levels = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
	const level = levels.includes(options.level ?? "")
		? (options.level as LevelWithSilent)
		: "info";
	const file = options.file ? rotatingLogFile(options.file) : undefined;
	writer = createLogWriter(
		{
			write(line) {
				(options.destination ?? process.stderr).write(line);
				file?.write(line);
			},
		},
		level,
	);
}

export function withLogContext<T>(fields: LogFields, action: () => T): T {
	return scope.run({ ...scope.getStore(), ...fields }, action);
}

function metadata(fields: LogFields) {
	return Object.fromEntries(
		Object.entries({ ...scope.getStore(), ...fields }).filter(
			([key, value]) =>
				keys.has(key as keyof LogFields) &&
				((typeof value === "string" && value.length <= 256) ||
					(typeof value === "number" && Number.isFinite(value))),
		),
	);
}

export function getLogger(component: string) {
	function log(
		level: "debug" | "info" | "warn" | "error",
		event: string,
		fields: LogFields = {},
		error?: unknown,
	) {
		// Error messages can contain tokens, URLs, SQL parameters or provider text.
		// Frames retain source locations, but never retain the first (message) line.
		const errorFrames =
			error instanceof Error
				? error.stack
						?.split("\n")
						.flatMap((line) => {
							const frame =
								/^\s+at .*?(?:\(|\s)(\/[^()\s?]+\.[cm]?[jt]sx?:\d+:\d+)\)?$/.exec(
									line,
								);
							return frame ? [frame[1]!.slice(0, 300)] : [];
						})
						.slice(0, 8)
				: undefined;
		writer[level]({
			...metadata(fields),
			component,
			event,
			...(errorFrames ? { errorFrames } : {}),
		});
	}
	return {
		debug: (event: string, fields?: LogFields, error?: unknown) =>
			log("debug", event, fields, error),
		info: (event: string, fields?: LogFields) => log("info", event, fields),
		warn: (event: string, fields?: LogFields, error?: unknown) =>
			log("warn", event, fields, error),
		error: (event: string, fields?: LogFields, error?: unknown) =>
			log("error", event, fields, error),
	};
}
