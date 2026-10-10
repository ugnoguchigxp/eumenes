import { z } from "zod";
import type { CodingEvent } from "./contracts";

function sanitize(text: string) {
	// eslint-disable-next-line no-control-regex -- ANSI and control bytes are untrusted terminal output.
	return text
		.replace(
			/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g,
			"",
		)
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
		.replace(/\b(?:sk-[\w-]{10,}|Bearer\s+[\w./+=-]{8,})/gi, "[redacted]")
		.slice(0, 32768);
}
export type Normalized = {
	kind: CodingEvent["kind"];
	text: string;
	sessionId?: string;
	turnFinished?: boolean;
};
export function normalize(line: string): Normalized | null {
	let v: Record<string, unknown>;
	try {
		v = JSON.parse(line);
	} catch {
		throw new Error("runner_invalid_jsonl");
	}
	if (
		!v ||
		typeof v !== "object" ||
		Array.isArray(v) ||
		typeof v.type !== "string"
	)
		throw new Error("runner_invalid_event");
	if (v.type === "thread.started") {
		const sessionId = z.uuid().parse(v.thread_id);
		return { kind: "session", text: "session_started", sessionId };
	}
	if (v.type === "turn.completed")
		return {
			kind: "turn_finished",
			text: "turn_completed",
			turnFinished: true,
		};
	if (v.type === "turn.failed" || v.type === "error")
		return { kind: "error", text: "cli_turn_failed" };
	const item = v.item;
	if (!item || typeof item !== "object" || Array.isArray(item)) return null;
	const i = item as Record<string, unknown>;
	if (
		v.type === "item.completed" &&
		i.type === "agent_message" &&
		typeof i.text === "string"
	)
		return { kind: "message", text: sanitize(i.text) };
	if (
		i.type === "command_execution" &&
		["item.started", "item.completed"].includes(v.type)
	)
		return {
			kind: v.type === "item.started" ? "command_started" : "command_finished",
			// No aggregate output, command arguments, reasoning or provider object persistence.
			text: JSON.stringify({
				status: ["completed", "failed", "in_progress"].includes(
					String(i.status),
				)
					? i.status
					: "unknown",
				exitCode: typeof i.exit_code === "number" ? i.exit_code : null,
			}),
		};
	if (i.type === "file_change" && v.type === "item.completed")
		return { kind: "file_changed", text: "workspace_changed" };
	return null;
}
/** Buffers bytes, not UTF-16 strings. Oversized lines are discarded while the pipe keeps draining. */
export class JsonLineDecoder {
	private parts: Buffer[] = [];
	private size = 0;
	private discarded = false;
	constructor(
		private readonly consume: (line: string) => void,
		private readonly fault: (code: string) => void,
		private readonly maxBytes = 1048576,
	) {}
	feed(chunk: Uint8Array) {
		const bytes = Buffer.from(chunk);
		let start = 0;
		for (let at = 0; at <= bytes.length; at++) {
			if (at !== bytes.length && bytes[at] !== 10) continue;
			const part = bytes.subarray(start, at);
			if (!this.discarded) {
				this.size += part.length;
				if (this.size > this.maxBytes) {
					this.parts = [];
					this.discarded = true;
					this.fault("runner_line_limit");
				} else this.parts.push(part);
			}
			if (at < bytes.length) {
				if (!this.discarded && this.size > 0) {
					try {
						this.consume(
							new TextDecoder("utf-8", { fatal: true }).decode(
								Buffer.concat(this.parts),
							),
						);
					} catch {
						this.fault("runner_invalid_output");
					}
				}
				this.parts = [];
				this.size = 0;
				this.discarded = false;
			}
			start = at + 1;
		}
	}
	finish() {
		if (this.size || this.discarded) this.fault("runner_partial_line");
		this.parts = [];
		this.size = 0;
	}
}
