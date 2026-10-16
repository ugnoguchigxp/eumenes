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
	exitCode?: number;
	processSignal?: string;
	selectionId?: string;
	toolchainId?: string;
	recipeId?: string;
	decision?: string;
	outcome?: string;
	retrieval?: string;
	candidateCount?: number;
	profile?: string;
	ttftMs?: number;
	providerTtftMs?: number;
	providerPromptMs?: number;
	providerDecodeMs?: number;
	providerPromptTokens?: number;
	providerCachedTokens?: number;
	providerOutputTokens?: number;
	totalMs?: number;
	requestBytes?: number;
	droppedMessages?: number;
	promptTokens?: number;
	completionTokens?: number;
	cachedTokens?: number;
	omitted?: number;
	messageCount?: number;
	applied?: number;
	rejected?: number;
	requestedRejected?: number;
	/** Saved connection id (an opaque id, never a URL or credential). */
	connectionId?: string;
	/** Agent connection auth: `subscription` or `api-key`. */
	auth?: string;
	/** Billing path the call ran or would have run on. */
	billingPath?: string;
	/** Credential kinds the agent CLI reported (enum values, never the credential). */
	apiProvider?: string;
	apiKeySource?: string;
	tokenSource?: string;
}
const keys = new Set<keyof LogFields>([
	"connectionId",
	"auth",
	"billingPath",
	"apiProvider",
	"apiKeySource",
	"tokenSource",
	"profile",
	"ttftMs",
	"providerTtftMs",
	"providerPromptMs",
	"providerDecodeMs",
	"providerPromptTokens",
	"providerCachedTokens",
	"providerOutputTokens",
	"totalMs",
	"requestBytes",
	"droppedMessages",
	"promptTokens",
	"completionTokens",
	"cachedTokens",
	"omitted",
	"messageCount",
	"applied",
	"rejected",
	"requestedRejected",
	"selectionId",
	"toolchainId",
	"recipeId",
	"decision",
	"outcome",
	"retrieval",
	"candidateCount",
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
	"exitCode",
	"processSignal",
]);
const scope = new AsyncLocalStorage<LogFields>();
const bootId = crypto.randomUUID();

/** A batch is written once this many characters are buffered. */
const FLUSH_BYTES = 64 * 1024;
/** Longest a buffered record waits before it is written. */
const FLUSH_INTERVAL_MS = 100;
/** Error and fatal records bypass the buffer so a crash right after them still leaves a trace. */
const URGENT_LEVEL = /"level":"(?:error|fatal)"/;

export interface RotatingLogFile extends DestinationStream {
	/** Writes everything buffered, synchronously. */
	flush(): void;
	/** Flushes and detaches the sink from the process-exit flush. */
	close(): void;
}

const openSinks = new Set<RotatingLogFile>();
let exitHookInstalled = false;
function installExitHook() {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	// A synchronous flush on exit keeps the final records of a crash or shutdown.
	process.on("exit", () => {
		for (const sink of openSinks) sink.flush();
	});
}

/**
 * Size-rotated JSONL file. Records are buffered and written in batches (interval, size,
 * rotation, error-level record, `flush()` and process exit) instead of one syscall per record.
 */
export function rotatingLogFile(
	path: string,
	maxBytes = 10 * 1024 * 1024,
	backups = 4,
	options?: { now?: () => number },
): RotatingLogFile {
	let retryAt = 0; // 0 = healthy
	let backoffMs = 1_000;
	let size = 0;
	let buffer: string[] = [];
	let buffered = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const now = options?.now ?? Date.now;
	function notice(level: string, event: string) {
		process.stderr.write(
			JSON.stringify({
				time: new Date().toISOString(),
				level,
				event,
				component: "logger",
				service: "eumenes",
				pid: process.pid,
				bootId,
				schemaVersion: 1,
			}) + "\n",
		);
	}
	function fail() {
		if (retryAt === 0) notice("error", "logging.file_unavailable");
		retryAt = now() + backoffMs;
		backoffMs = Math.min(backoffMs * 2, 60_000);
	}
	function recovered() {
		if (retryAt !== 0) notice("info", "logging.file_recovered");
		retryAt = 0;
		backoffMs = 1_000;
	}
	function prepare() {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		appendFileSync(path, "", { mode: 0o600 });
		chmodSync(path, 0o600);
		size = statSync(path).size;
	}
	function rotate() {
		rmSync(`${path}.${backups}`, { force: true });
		for (let n = backups - 1; n >= 1; n--)
			if (existsSync(`${path}.${n}`))
				renameSync(`${path}.${n}`, `${path}.${n + 1}`);
		renameSync(path, `${path}.1`);
		size = 0;
	}
	try {
		prepare();
	} catch {
		fail();
	}
	function flush() {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		const lines = buffer;
		buffer = [];
		buffered = 0;
		if (lines.length === 0) return;
		// An outage drops what arrives during its backoff; stderr still carries every record.
		if (retryAt !== 0 && now() < retryAt) return;
		try {
			if (retryAt !== 0) prepare();
			let batch = "";
			let batchBytes = 0;
			const append = () => {
				if (!batch) return;
				appendFileSync(path, batch, { mode: 0o600 });
				size += batchBytes;
				batch = "";
				batchBytes = 0;
			};
			for (const line of lines) {
				const bytes = Buffer.byteLength(line);
				if (size + batchBytes && size + batchBytes + bytes > maxBytes) {
					append();
					rotate();
				}
				batch += line;
				batchBytes += bytes;
			}
			append();
			recovered();
		} catch {
			fail();
		}
	}
	const sink: RotatingLogFile = {
		write(line) {
			buffer.push(line);
			buffered += line.length;
			if (buffered >= FLUSH_BYTES || URGENT_LEVEL.test(line)) flush();
			else if (timer === undefined) {
				timer = setTimeout(flush, FLUSH_INTERVAL_MS);
				timer.unref();
			}
		},
		flush,
		close() {
			flush();
			openSinks.delete(sink);
		},
	};
	openSinks.add(sink);
	installExitHook();
	return sink;
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

let fileSink: RotatingLogFile | undefined;

export function configureLogging(options: {
	file?: string;
	level?: string;
	destination?: DestinationStream;
}) {
	const levels = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
	const level = levels.includes(options.level ?? "")
		? (options.level as LevelWithSilent)
		: "info";
	fileSink?.close();
	const file = options.file ? rotatingLogFile(options.file) : undefined;
	fileSink = file;
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
