const codePattern = /^[a-z][a-z0-9_:]{0,100}$/;

/** True for a machine-readable code such as `larm_inference_401`. */
export function isErrorCode(value: unknown): value is string {
	return typeof value === "string" && codePattern.test(value);
}

/** Machine-readable code only; free text (provider output, URLs, SQL errors) collapses to the fallback. */
export function toErrorCode(error: unknown, fallback: string): string {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	return isErrorCode(message) ? message : fallback;
}

const networkCodes = new Set([
	"ConnectionRefused",
	"ConnectionClosed",
	"ConnectionReset",
	"FailedToOpenSocket",
	"ECONNREFUSED",
	"ECONNRESET",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
]);

const networkMessages = [
	"fetch failed", // Node/undici
	"Unable to connect", // Bun: connection refused
	"The socket connection was closed unexpectedly", // Bun: reset mid-request/stream
	"terminated", // undici: body stream aborted by the peer
];

/** A transport failure of fetch (Bun sets `code`; Node wraps it in `cause`). Bugs that throw TypeError are not. */
export function isNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as { code?: unknown }).code;
	const causeCode = (error.cause as { code?: unknown } | undefined)?.code;
	return (
		(typeof code === "string" && networkCodes.has(code)) ||
		(typeof causeCode === "string" && networkCodes.has(causeCode)) ||
		// Backstop for transport errors that arrive without a code (TLS, proxies, other runtimes).
		(error instanceof TypeError &&
			networkMessages.some((m) => error.message.startsWith(m)))
	);
}

/** Store-level conditions that say nothing about the item being processed (busy writer, shutdown, SQLite lock). */
export function isTransientStoreError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as { code?: unknown }).code;
	return (
		error.message === "database_closing" ||
		error.message === "database_writer_queue_full" || // WriterBusyError (api/infrastructure/sqlite)
		(typeof code === "string" && /^SQLITE_(BUSY|LOCKED)/.test(code))
	);
}
