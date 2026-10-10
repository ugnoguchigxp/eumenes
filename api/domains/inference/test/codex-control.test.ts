import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createSettings,
	migrations as settingsMigrations,
} from "../../settings";
import { createInference, migrations } from "..";
import type { Messages } from "../contracts";

const messages: Messages = [{ role: "user", content: "資料を比較する" }];
async function fixture(
	execute?: (messages: Messages, signal: AbortSignal) => Promise<string>,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-codex-control-"));
	const dbPath = join(dir, "db");
	const store = openStore(dbPath, [...settingsMigrations, ...migrations]);
	const settings = await createSettings(store, { dbPath, env: {} });
	const inference = createInference(store, settings, {
		codexResearch: execute ? { model: "gpt-6-luna", execute } : undefined,
	});
	await store.write((db) =>
		inference.captureInTransaction(db, "root", "llm", Date.now() + 30000),
	);
	const capture = (subject: string, engine?: "codex_luna") =>
		store.write((db) =>
			inference.captureControlInTransaction(db, {
				subject,
				policySubject: "root",
				deadline: Date.now() + 10000,
				maxOutputTokens: 2048,
				engine,
			}),
		);
	return {
		store,
		inference,
		capture,
		async close() {
			await inference.close();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("Luna controls persist their engine and use common receipts, cancellation and usage history", async () => {
	const seen: Messages[] = [];
	const h = await fixture(async (m) => {
		seen.push(m);
		return '{"action":"finish"}';
	});
	try {
		const id = await h.capture("agent:step:1", "codex_luna");
		expect(await h.capture("agent:step:1", "codex_luna")).toBe(id);
		await expect(h.capture("agent:step:1")).rejects.toThrow(
			"control_engine_conflict",
		);
		const receipt = await h.inference.executeControl(
			id,
			messages,
			AbortSignal.timeout(3000),
		);
		expect(seen).toEqual([messages]);
		expect(
			h.store.read((db) =>
				db
					.query(
						"SELECT source,model,status FROM inference_attempts WHERE request_id=?",
					)
					.get(id),
			),
		).toEqual({ source: "codex", model: "gpt-6-luna", status: "succeeded" });
		expect(
			await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
		).toBe(true);
		const next = await h.capture("agent:step:2", "codex_luna");
		const late = await h.inference.executeControl(
			next,
			messages,
			AbortSignal.timeout(3000),
		);
		await h.store.write((db) =>
			h.inference.cancelRequestsInTransaction(db, [next]),
		);
		expect(
			await h.store.write((db) => h.inference.acceptInTransaction(db, late)),
		).toBe(false);
	} finally {
		await h.close();
	}
});

test("cancelled Luna work cannot return a late result even if the provider ignores its signal", async () => {
	let release: (text: string) => void = () => {};
	let started: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const h = await fixture(async () => {
		started();
		return new Promise<string>((resolve) => {
			release = resolve;
		});
	});
	try {
		const id = await h.capture("agent:step:late", "codex_luna");
		const abort = new AbortController();
		const work = h.inference.executeControl(id, messages, abort.signal);
		await ready;
		abort.abort();
		await expect(work).rejects.toThrow("cancelled");
		release('{"action":"finish"}');
		expect(
			h.store.read((db) =>
				db
					.query("SELECT status FROM inference_attempts WHERE request_id=?")
					.get(id),
			),
		).toEqual({ status: "failed" });
	} finally {
		release("{}");
		await h.close();
	}
});

test("unavailable Luna is rejected without recording a request or falling back to another model", async () => {
	const h = await fixture();
	try {
		expect(h.inference.codexResearchAvailable()).toBe(false);
		await expect(h.capture("agent:step:missing", "codex_luna")).rejects.toThrow(
			"codex_research_unavailable",
		);
		expect(
			h.store.read((db) =>
				db
					.query(
						"SELECT id FROM inference_requests WHERE subject='agent:step:missing'",
					)
					.get(),
			),
		).toBeNull();
	} finally {
		await h.close();
	}
});
