import type { LogFields } from "../../../infrastructure/logger";

/** Parse external transport metadata, never task meaning or provider prose. */
export class CodexResearchFailure extends Error {
	constructor(public readonly diagnostic: LogFields) {
		super(String(diagnostic.reason));
	}
}
export function codexFailure(
	error: unknown,
	phase: string,
): CodexResearchFailure {
	if (error instanceof CodexResearchFailure) return error;
	const message = error instanceof Error ? error.message : String(error);
	const exit = /^Codex Exec exited with code (\d+):/.exec(message);
	const signal = /^Codex Exec exited with signal (SIG[A-Z]+):/.exec(
		message,
	)?.[1];
	const status = /(?:\bHTTP\s+|\bstatus(?: code)?[":=\s]+)([45]\d\d)\b/i.exec(
		message,
	)?.[1];
	const codes = [
		"invalid_json_schema",
		"model_not_found",
		"insufficient_quota",
		"rate_limit_exceeded",
		"invalid_api_key",
	];
	const providerCode = codes.find((code) =>
		new RegExp(`\\b${code}\\b`).test(message),
	);
	const reason =
		message === "codex_research_output_limit" ||
		message === "codex_research_spawn_failed"
			? message
			: status
				? `codex_research_http_${status}`
				: providerCode
					? `codex_research_${providerCode}`
					: exit
						? "codex_research_process_exit"
						: signal
							? "codex_research_process_signal"
							: message.startsWith("Failed to parse item:")
								? "codex_research_invalid_event"
								: error instanceof Error &&
									  "code" in error &&
									  error.code === "ENOENT"
									? "codex_research_spawn_failed"
									: "codex_research_failed";
	return new CodexResearchFailure({
		phase,
		reason,
		...(exit ? { exitCode: Number(exit[1]) } : {}),
		...(signal &&
		["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"].includes(signal)
			? { processSignal: signal }
			: {}),
		...(status ? { status: Number(status) } : {}),
		...(providerCode ? { validationCode: providerCode } : {}),
	});
}
