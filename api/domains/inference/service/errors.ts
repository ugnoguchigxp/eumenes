export const fallbackErrors =
	/^(larm_unconfigured|larm_base_url_unconfigured|larm_(control|inference)_(429|502|503|504)|larm_connection_(failed|expired)|larm_expired|larm_credential_expired|larm_renew_busy|larm_connect_timeout|network_unavailable|local_timeout)$/;

export function safeError(error: unknown, signal: AbortSignal): string {
	if (signal.aborted)
		return signal.reason instanceof DOMException &&
			signal.reason.name === "TimeoutError"
			? "deadline_exceeded"
			: "cancelled";
	if (error instanceof DOMException && error.name === "TimeoutError")
		return "local_timeout";
	if (error instanceof TypeError) return "network_unavailable";
	const message = error instanceof Error ? error.message : "inference_failed";
	return /^[a-z][a-z0-9_]{0,100}$/.test(message) ? message : "inference_failed";
}
