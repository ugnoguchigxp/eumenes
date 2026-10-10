import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRunner, publishSpec, readReceipt } from "../src/core";
import { normalize } from "../src/decoder";
import { atomicWrite, runPath } from "../src/storage";
import {
	messageMetadataSchema,
	runObservationSchema,
} from "../src/observation";
import { fixture, until } from "./support";

function widen(f: ReturnType<typeof fixture>) {
	atomicWrite(f.configPath, {
		...f.config,
		fixtureLimits: {
			...f.config.fixtureLimits,
			maxLineBytes: 1048576,
			maxRunBytes: 1048576,
		},
	});
}
async function run(f: ReturnType<typeof fixture>, mode: string) {
	const runner = createRunner(f.configPath, true),
		spec = f.spec(mode);
	publishSpec(f.config, "spec", spec);
	await runner.start("spec", spec.operationId, spec.executionId, false);
	await until(
		() => runner.inspect(spec.executionId, 0, 100, false),
		(r) => r.receipt.childrenStopped && r.receipt.state !== "stopping",
	);
	const r = runner.inspect(spec.executionId, 0, 100, false);
	return { runner, spec, ...r };
}
const message = (text: string, extra: object = {}) =>
	normalize(
		JSON.stringify({
			type: "item.completed",
			item: { type: "agent_message", text, ...extra },
		}),
	)!;

describe("decoder observation facts", () => {
	test("messages are unknown without a phase and never inferred from position", () => {
		const m = message("完了しました").message!;
		expect(m).toMatchObject({
			messageKind: "unknown",
			classificationReason: "phase_not_provided",
			contentPresence: "nonempty",
			sourceTruncated: false,
		});
		expect(m.retainedBytes).toBe(m.sanitizedBytes!);
	});
	test("an unsupported phase stays unknown and a blank message is empty", () => {
		expect(message("x", { phase: "final_answer" }).message).toMatchObject({
			messageKind: "unknown",
			classificationReason: "phase_unsupported",
		});
		expect(message("  \n ").message?.contentPresence).toBe("empty");
	});
	test("the 32768-unit limit keeps whole code points and reports truncation", () => {
		const n = message("😀".repeat(20000));
		expect(n.text.length).toBeLessThanOrEqual(32768);
		expect(n.text.length % 2).toBe(0);
		expect(n.message).toMatchObject({ sourceTruncated: true });
		expect(n.message!.retainedBytes!).toBeLessThan(n.message!.sanitizedBytes!);
	});
	test("a lone surrogate is a protocol fault, not a replacement character", () => {
		expect(() =>
			normalize(
				'{"type":"item.completed","item":{"type":"agent_message","text":"\\ud800"}}',
			),
		).toThrow("runner_invalid_unicode");
	});
	test("only turn.completed and turn.failed are terminal; a general error is not", () => {
		expect(normalize('{"type":"turn.completed"}')?.turnOutcome).toBe(
			"completed",
		);
		expect(normalize('{"type":"turn.failed"}')?.turnOutcome).toBe("failed");
		expect(
			normalize('{"type":"error","message":"x"}')?.turnOutcome,
		).toBeUndefined();
	});
	test("a classification needs an explicit contract", () => {
		expect(
			messageMetadataSchema.safeParse({
				messageKind: "final_answer",
				classificationReason: "phase_not_provided",
				contentPresence: "nonempty",
				sourceTruncated: false,
				sanitizedBytes: 1,
				retainedBytes: 1,
			}).success,
		).toBe(false);
		expect(
			runObservationSchema.safeParse({
				turnOutcome: "completed",
				terminalEventSeq: null,
				processStarted: true,
				captureState: "complete",
				captureIssues: [],
			}).success,
		).toBe(false);
	});
});
describe("runner observation", () => {
	test("completed turn: terminal seq, started process, complete capture", async () => {
		const f = fixture();
		try {
			const r = await run(f, "normal");
			expect(r.receipt.observation).toMatchObject({
				turnOutcome: "completed",
				processStarted: true,
				captureState: "complete",
				captureIssues: [],
			});
			const terminal = r.events.find((e) => e.kind === "turn_finished")!;
			expect(r.receipt.observation.terminalEventSeq).toBe(terminal.seq);
			const msg = r.events.find((e) => e.kind === "message")!;
			expect(msg.message?.messageKind).toBe("unknown");
		} finally {
			f.close();
		}
	});
	test("failed turn keeps a complete capture while the success gate is false", async () => {
		const f = fixture();
		try {
			const r = await run(f, "failed");
			expect(r.receipt.evidenceComplete).toBe(false);
			expect(r.receipt.turnFinished).toBe(false);
			expect(r.receipt.observation).toMatchObject({
				turnOutcome: "failed",
				captureState: "complete",
				processStarted: true,
			});
		} finally {
			f.close();
		}
	});
	test("process exit without a terminal leaves the turn unconfirmed", async () => {
		const f = fixture();
		try {
			const r = await run(f, "noterminal");
			expect(r.receipt.state).toBe("exited");
			expect(r.receipt.exitCode).toBe(0);
			expect(r.receipt.observation).toMatchObject({
				turnOutcome: "unconfirmed",
				terminalEventSeq: null,
			});
		} finally {
			f.close();
		}
	});
	test("a contradictory terminal is a conflict, not an overwrite", async () => {
		const f = fixture();
		try {
			const r = await run(f, "conflict");
			expect(r.receipt.observation.turnOutcome).toBe("conflict");
			expect(r.receipt.evidenceComplete).toBe(false);
		} finally {
			f.close();
		}
	});
	test("a 40000-character message is flagged as truncated without a capture fault", async () => {
		const f = fixture();
		try {
			widen(f);
			const r = await run(f, "longmsg");
			const msg = r.events.find((e) => e.kind === "message")!;
			expect(msg.message?.sourceTruncated).toBe(true);
			expect(r.receipt.observation.captureState).toBe("complete");
			expect(r.receipt.evidenceComplete).toBe(true);
			const body = r.runner.readEvidence(
				r.spec.executionId,
				msg.payloadRef,
				0,
				65536,
			);
			expect(body.totalBytes).toBe(msg.message!.retainedBytes!);
		} finally {
			f.close();
		}
	});
	test("an empty message is reported as empty and a malformed line is a capture fault", async () => {
		const f = fixture();
		try {
			const r = await run(f, "emptymsg");
			expect(
				r.events.find((e) => e.kind === "message")?.message?.contentPresence,
			).toBe("empty");
			const g = fixture();
			try {
				const p = await run(g, "partial");
				expect(p.receipt.observation).toMatchObject({
					captureState: "incomplete",
					captureIssues: ["invalid_event"],
				});
				const q = fixture();
				try {
					const cut = await run(q, "trunc");
					expect(cut.receipt.observation.captureIssues).toContain(
						"partial_line",
					);
					expect(cut.receipt.evidenceComplete).toBe(false);
				} finally {
					q.close();
				}
			} finally {
				g.close();
			}
		} finally {
			f.close();
		}
	});
	test("stopping before spawn proves the CLI never started", async () => {
		const f = fixture();
		try {
			const runner = createRunner(f.configPath, true),
				spec = f.spec();
			publishSpec(f.config, "spec", spec);
			const r = runner.stop(spec.executionId, 1, crypto.randomUUID(), "cancel");
			expect(r.observation.processStarted).toBe(false);
			expect(r.reason).toBe("stopped_before_spawn");
		} finally {
			f.close();
		}
	});
	test("a receipt written before observations exist reads as unknown, never as success", async () => {
		const f = fixture();
		try {
			const r = await run(f, "normal");
			const path = join(
				runPath(f.config.spoolRoot, r.spec.executionId),
				"receipt.json",
			);
			const legacy = JSON.parse(readFileSync(path, "utf8"));
			delete legacy.observation;
			atomicWrite(path, legacy);
			expect(
				readReceipt(f.config, r.spec.executionId).observation,
			).toMatchObject({
				turnOutcome: "unconfirmed",
				processStarted: "unknown",
				captureState: "unknown",
			});
		} finally {
			f.close();
		}
	});
});

describe("continuation and legacy specs", () => {
	test("a v1 session or a non-completed turn is never continued", async () => {
		const f = fixture();
		try {
			const first = await run(f, "failed");
			const next = {
				...f.spec(),
				kind: "continue" as const,
				sessionId: first.receipt.sessionId,
				previousExecutionId: first.spec.executionId,
			};
			publishSpec(f.config, "next", next);
			expect(() =>
				first.runner.start("next", next.operationId, next.executionId, true),
			).toThrow("runner_session_busy_or_stale");
			const specPath = join(
				runPath(f.config.spoolRoot, first.spec.executionId),
				"spec.json",
			);
			atomicWrite(specPath, { ...first.spec, version: "eumenes-coding/1" });
			const again = {
				...next,
				operationId: crypto.randomUUID(),
				executionId: crypto.randomUUID(),
			};
			publishSpec(f.config, "again", again);
			expect(() =>
				first.runner.start("again", again.operationId, again.executionId, true),
			).toThrow("coding_legacy_continue_unsupported");
		} finally {
			f.close();
		}
	});
	test("a v1 spec is never started", async () => {
		const f = fixture();
		try {
			const runner = createRunner(f.configPath, true);
			const legacy = { ...f.spec(), version: "eumenes-coding/1" as const };
			publishSpec(f.config, "legacy", legacy);
			expect(() =>
				runner.start("legacy", legacy.operationId, legacy.executionId, false),
			).toThrow("runner_protocol_mismatch");
		} finally {
			f.close();
		}
	});
});
