import { ApiConnectionError, ApiError } from "../client";

/** A local input contract violation, distinct from an invalid response from the server. */
export class CliInputError extends Error {}

/** Keep interactive commands and the CLI entry point's diagnostics and exit codes consistent. */
export function cliFailure(error: unknown, fallbackExitCode = 2) {
	if (error instanceof ApiError)
		return {
			exitCode: error.status === 401 ? 2 : 3,
			lines: [
				error.message,
				...(error.requestId ? [`API request ID: ${error.requestId}`] : []),
			],
		};
	if (error instanceof ApiConnectionError)
		return {
			exitCode: 5,
			lines: [
				`Cannot connect to ${process.env.EUMENES_URL ?? "http://127.0.0.1:8787"}. Start backend with bun run start.`,
			],
		};
	return {
		exitCode: error instanceof CliInputError ? 2 : fallbackExitCode,
		lines: [error instanceof Error ? error.message : String(error)],
	};
}
