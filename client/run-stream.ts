import {
	progressSchema,
	type RunProgress,
} from "../api/domains/dialogue/contracts";
import type { Transport } from "./transport";
export async function watchRun(
	transport: Transport,
	id: string,
	signal: AbortSignal,
	onProgress: (value: RunProgress) => void,
) {
	const response = await transport.call(
		`/api/runs/${encodeURIComponent(id)}/stream`,
		{ signal, headers: { Accept: "text/event-stream" } },
	);
	if (
		!response.headers.get("content-type")?.includes("text/event-stream") ||
		!response.body
	)
		throw new Error("invalid_run_stream");
	const reader = response.body.getReader(),
		decoder = new TextDecoder();
	let buffer = "",
		complete = false;
	const stop = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", stop, { once: true });
	let watchdog = setTimeout(stop, 45000);
	try {
		for (;;) {
			const result = await reader.read();
			signal.throwIfAborted();
			if (result.done) break;
			clearTimeout(watchdog);
			watchdog = setTimeout(stop, 45000);
			buffer += decoder.decode(result.value, { stream: true });
			if (buffer.length > 1_000_000) throw new Error("run_frame_too_large");
			let end: number;
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const raw = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const data = raw
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (!data) continue;
				const value = progressSchema.parse(JSON.parse(data));
				if (value.runId !== id) throw new Error("run_stream_mismatch");
				onProgress(value);
				complete = !["queued", "running"].includes(value.status);
			}
			if (complete) break;
		}
		if (!complete) throw new Error("run_stream_disconnected");
	} finally {
		clearTimeout(watchdog);
		signal.removeEventListener("abort", stop);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
