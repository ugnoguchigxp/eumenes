import { expect, test } from "bun:test";
import { Hono } from "hono";
import { waitFor } from "../../../infrastructure/wait-for";
import { registerDialogue } from "..";
import { setup, type Call } from "./generation.fixture";

function normalized(calls: Call[]) {
	return JSON.stringify(calls)
		.replaceAll(
			/\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d+)?Z)?|\d\d-\d\d（.）|\d\d:\d\d(?::\d\d)?/g,
			"<time>",
		)
		.replaceAll(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, "<id>");
}

test("OFF keeps normal and failing turns identical, with no diagnostic capture, inference or job", async () => {
	let captures = 0;
	let inference = 0;
	const baseline = await setup();
	const off = await setup({
		debugDiagnostics: { enabled: () => false },
		debugInference: {
			captureInTransaction(_db, subject) {
				if (subject.startsWith("dialogue.debug_diagnostics:")) captures++;
				return `req:${subject}`;
			},
			async executeRequest() {
				inference++;
				throw new Error("unexpected");
			},
		},
	});
	try {
		for (const h of [baseline, off]) {
			h.state.steps.push(
				{ text: "こんにちは。" },
				{ fail: "unknown_test_error" },
			);
			await h.say("こんにちは");
			await h.say("もう一度", "failed");
			expect(h.state.calls).toHaveLength(2);
		}
		expect(normalized(off.state.calls)).toBe(normalized(baseline.state.calls));
		expect(
			off.queue.list({ kind: "dialogue.debug_diagnostics" }).items,
		).toEqual([]);
		expect([captures, inference]).toEqual([0, 0]);
		const app = new Hono();
		registerDialogue(app, off.dialogue);
		expect(
			(await app.request("/api/conversations/main/debug-diagnostics")).status,
		).toBe(404);
	} finally {
		await off.close();
		await baseline.close();
	}
});

test("ON diagnoses a failed run once and returns only scoped display data; turning OFF drops it", async () => {
	let enabled = true;
	let changed = () => {};
	const diagnosticCalls: unknown[] = [];
	const h = await setup({
		debugDiagnostics: {
			enabled: () => enabled,
			onChange(listener) {
				changed = listener;
				return () => {};
			},
		},
		debugInference: {
			captureInTransaction(_db, id) {
				return id;
			},
			async executeRequest(
				requestId,
				messages,
				_signal,
				_preparation,
				session,
			) {
				diagnosticCalls.push({ messages, session });
				return {
					requestId,
					attemptId: "debug-attempt",
					value: "会話の処理が失敗しました。詳しい原因は確認できません。",
				};
			},
		},
	});
	try {
		h.state.steps.push({ fail: "fixture_diagnostic_failure" });
		const failed = await h.say("失敗する合成入力", "failed");
		const diagnostics = h.dialogue.debugDiagnostics!;
		await waitFor(() => diagnostics.list("main")?.entries.length === 1);
		const entry = diagnostics.list("main")!.entries[0]!;
		expect(entry.runId).toBe(failed.id);
		expect(entry.summary).toContain("詳しい原因");
		expect(JSON.stringify(diagnosticCalls)).toContain(
			"fixture_diagnostic_failure",
		);
		expect(diagnosticCalls).toHaveLength(1);
		expect(JSON.stringify(diagnosticCalls)).not.toContain("失敗する合成入力");
		expect(diagnostics.detail("other", entry.id)).toBeNull();
		expect(JSON.stringify(h.log())).not.toContain("詳しい原因");

		enabled = false;
		changed();
		expect(diagnostics.list("main")).toBeNull();
		expect(diagnostics.detail("main", entry.id)).toBeNull();
		h.state.steps.push({ text: "あとからの返事です。" });
		await h.say("別の質問です");
		expect(JSON.stringify(h.state.calls.at(-1))).not.toContain(
			"target.kind=run",
		);
		expect(JSON.stringify(h.state.calls.at(-1))).not.toContain("詳しい原因");
		expect(diagnosticCalls).toHaveLength(1);
	} finally {
		await h.close();
	}
});

test("a diagnostic read produces a separate explanation without writing its tool result or reply to the conversation", async () => {
	const h = await setup({
		debugDiagnostics: { enabled: () => true },
		debugInference: {
			captureInTransaction(_db, id) {
				return id;
			},
			async executeRequest(requestId) {
				return {
					requestId,
					attemptId: "debug-read",
					value: "依頼と結果を確認しました。",
				};
			},
		},
	});
	try {
		h.state.steps.push({ text: "作業の返事です。" });
		const original = await h.say("作業をお願い");
		h.state.steps.push({
			calls: [{ name: "read_runs", args: { target: { kind: "run" } } }],
		});
		const followup = await h.say("頼んだことと違うみたい。");
		const diagnostics = h.dialogue.debugDiagnostics!;
		await waitFor(() => diagnostics.list("main")?.entries.length === 1);
		expect(diagnostics.list("main")?.entries[0]?.runId).toBe(original.id);
		expect(followup.answerMessageId).toBeNull();
		expect(h.state.calls).toHaveLength(2);
		expect(JSON.stringify(h.log())).not.toContain("依頼と結果を確認");
		expect(JSON.stringify(h.log())).not.toContain('"name":"read_runs"');
	} finally {
		await h.close();
	}
});

test("repeated automatic candidates are bounded and queued results from an earlier mode never run", async () => {
	let enabled = false;
	let changed = () => {};
	let calls = 0;
	const h = await setup({
		debugDiagnostics: {
			enabled: () => enabled,
			onChange(listener) {
				changed = listener;
				return () => {};
			},
		},
		debugInference: {
			captureInTransaction(_db, id) {
				return id;
			},
			async executeRequest(requestId) {
				calls++;
				return { requestId, attemptId: "debug-repeat", value: "説明" };
			},
		},
	});
	try {
		h.state.steps.push({ fail: "fixture_diagnostic_failure" });
		const run = await h.say("未処理の実行", "failed");
		const diagnostics = h.dialogue.debugDiagnostics!;
		enabled = true;
		changed();
		await h.store.write((db) => {
			for (let i = 0; i < 1000; i++)
				diagnostics.enqueue(db, "main", run.id, run.id, false, String(i));
			// Simulate disabling before a worker can claim this committed batch.
			enabled = false;
		});
		changed();
		expect(
			h.queue.list({ kind: "dialogue.debug_diagnostics" }).items,
		).toHaveLength(3);
		expect(diagnostics.list("main")).toBeNull();
		enabled = true;
		changed();
		await waitFor(() =>
			h.queue
				.list({ kind: "dialogue.debug_diagnostics" })
				.items.some(({ state }) => state === "cancelled"),
		);
		expect(calls).toBe(0);
		expect(diagnostics.list("main")?.entries).toEqual([]);
	} finally {
		await h.close();
	}
});
