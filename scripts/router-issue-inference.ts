/** The normal background-control path, with request state in RAM and saved configuration read-only. */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SqliteStore } from "../api/infrastructure/sqlite";
import { createSettings } from "../api/domains/settings";
import {
	createCloudAgents,
	createCodexHost,
	createInference,
} from "../api/domains/inference";
import { migrations } from "../api/application/migrations";
import { resolveLarmToken } from "../api/infrastructure/auth-config";

export async function routerIssueInference(dbPath: string) {
	const keyDir = process.env.EUMENES_KEY_DIR || join(dirname(dbPath), "keys");
	if (
		!process.env.EUMENES_SECRET_KEY &&
		!existsSync(join(keyDir, "settings.key"))
	)
		throw new Error("saved_settings_key_unavailable");
	const db = new Database(dbPath, { readonly: true });
	// Any attempted upgrade is rejected by SQLite; the evaluation never opens a product writer.
	const reader = {
		read: <T>(fn: (tx: Database) => T) => fn(db),
		write: async <T>(fn: (tx: Database) => T) => fn(db),
	} as SqliteStore;
	let memory: SqliteStore | undefined;
	// A Codex home of the evaluation's own: the backend empties its home when it starts, and so would this.
	const codexRoot = await mkdtemp(join(tmpdir(), "router-issue-codex-"));
	try {
		const saved = await createSettings(reader, { dbPath, env: process.env });
		const requestDb = new Database(":memory:");
		for (const migration of migrations) requestDb.exec(migration.sql);
		const committed = new Set<() => void>();
		memory = {
			read: (fn) => fn(requestDb),
			readSnapshot: (fn) => requestDb.transaction(fn)(requestDb),
			write: async (fn) => {
				const result = requestDb.transaction(fn)(requestDb);
				for (const notify of committed) notify();
				return result;
			},
			onCommit: (fn) => {
				committed.add(fn);
				return () => {
					committed.delete(fn);
				};
			},
			close: async () => {
				requestDb.close();
			},
		};
		const inference = createInference(
			memory,
			{
				...saved,
				inTransaction: () => saved.get(),
				valid: (_tx, snapshot, purpose, connection) =>
					saved.valid(db, snapshot, purpose, connection),
				// Evaluation connections have their own identity, so closing them cannot release the live host's lease.
				derivedKey: () => undefined,
			},
			{
				token: resolveLarmToken(process.env),
				cloudAgents: createCloudAgents(process.env, {
					codexHost: createCodexHost(process.env, {
						home: join(codexRoot, "codex-home"),
					}),
				}),
			},
		);
		return {
			async analyze(
				prompt: {
					system: string;
					user: string;
					outputSchema: Record<string, unknown>;
				},
				timeoutMs: number,
				resourceId: string | null,
			) {
				const deadline = Date.now() + timeoutMs;
				const id = await memory!.write((tx) =>
					inference.captureBackgroundControlInTransaction(tx, {
						taskId: "router-structure-eval",
						decisionId: crypto.randomUUID(),
						authorityEpoch: 1,
						executionGeneration: 1,
						deadline,
						taskDeadline: deadline,
						maxOutputTokens: 1024,
						structuredOutput: true,
						route: resourceId ? { resourceId } : "conversation",
					}),
				);
				const receipt = await inference.executeControl(
					id,
					[
						{ role: "system", content: prompt.system },
						{ role: "user", content: prompt.user },
					],
					AbortSignal.timeout(timeoutMs),
					{
						instructions: "",
						outputSchema: prompt.outputSchema,
						reasoningEffort: "low",
					},
					{ sessionRole: "auxiliary" },
				);
				return typeof receipt.value === "string"
					? receipt.value
					: new TextDecoder().decode(receipt.value);
			},
			async close() {
				await inference.close();
				await memory!.close();
				db.close();
				await rm(codexRoot, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await memory?.close();
		db.close();
		await rm(codexRoot, { recursive: true, force: true });
		throw error;
	}
}
