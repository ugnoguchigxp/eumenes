import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as packageSql } from "eumenes-interact/sqlite";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import {
	createBrowserInteract,
	migrations,
	interactMigrations,
	type InteractInference,
} from "..";
import {
	FakeDriver,
	FakeEncoder,
	FakeFiles,
	fakeResolver,
	WEB,
	until,
} from "./fakes";

export const interactFixtureMigrations = [
	...queueMigrations,
	...migrations,
	...packageSql.map((sql, i) => ({
		id: `interact-package/${String(i + 1).padStart(4, "0")}`,
		after: [
			i
				? `interact-package/${String(i).padStart(4, "0")}`
				: migrations.at(-1)!.id,
		],
		sql,
	})),
	...interactMigrations,
];
export class InteractFakeDriver extends FakeDriver {
	async readText() {
		return {
			url: this.tabs[0]!.url,
			title: "Fixture",
			text: "The public result is ready.",
			charCount: 27,
			truncated: false,
			root: "main" as const,
		};
	}
}
export const part = (name: string, args: unknown) =>
	JSON.stringify({ part: name, args });
export const read = part("page.read", { target: null, maxChars: 1000 });
export const unmet = part("done", {
	answer: "確認できませんでした",
	outcome: "unmet",
	basis: "observed",
	evidence: [],
});
export function done(input: Parameters<InteractInference>[0]) {
	const text = input.prepared.messages.map((m) => m.content).join("\n");
	const ids = [...text.matchAll(/"resultId"\s*:\s*"([^"]+)"/g)].map(
		(m) => m[1],
	);
	return part("done", {
		answer: "確認しました",
		outcome: "achieved",
		basis: "observed",
		evidence: [...new Set(ids)],
	});
}
export async function interactFixture(
	options: {
		infer?: InteractInference;
		responses?: Array<string | typeof done>;
		now?: () => number;
		sourceValid?: () => boolean;
		startQueue?: boolean;
		directory?: string;
		owner?: string;
	} = {},
) {
	const dir =
		options.directory ?? mkdtempSync(join(tmpdir(), "eumenes-interact-test-"));
	const store = openStore(join(dir, "db"), interactFixtureMigrations);
	const now = options.now ?? Date.now;
	const queue = createQueue(store, {
		now,
		pollMs: 5,
		heartbeatMs: 10,
		leaseMs: 5000,
	});
	const driver = new InteractFakeDriver();
	const files = new FakeFiles();
	const encoder = new FakeEncoder();
	const responses = options.responses ?? [read, done];
	const calls: Parameters<InteractInference>[0][] = [];
	const service = createBrowserInteract({
		store,
		queue,
		now,
		createDriver: () => driver,
		files,
		encoder,
		resolveHost: fakeResolver(),
		webOrigins: [WEB],
		skill: {
			ref: "skill:browser.interact.operator@1",
			digest: `sha256:${"a".repeat(64)}`,
		},
		reviewInstructions: "Review actual evidence only",
		validSource: () => options.sourceValid?.() ?? true,
		infer: async (...args) => {
			calls.push(args[0]);
			if (options.infer) return options.infer(...args);
			if (args[0].purpose === "completion_review")
				return JSON.stringify({
					outcome: "achieved",
					explanation: "Result matches fixture",
				});
			const v = responses.shift() ?? unmet;
			return typeof v === "function" ? v(args[0]) : v;
		},
	});
	const owner = options.owner ?? "owner",
		conversationId = "main";
	const start = async (
		input: Record<string, unknown> = {},
		id = crypto.randomUUID(),
		context: Parameters<typeof service.startInTransaction>[4] = {},
	) => {
		const v = await store.write((db) =>
			service.startInTransaction(
				db,
				owner,
				id,
				{
					request: "read the public result",
					startUrl: WEB,
					conversationId,
					...input,
				},
				context,
			),
		);
		service.afterCommit();
		return v;
	};
	const status = (id: string) =>
		store.read((db) =>
			service.statusInTransaction(db, owner, conversationId, id),
		);
	const wait = async (id: string, state: string) => {
		await until(
			() => {
				const v = status(id);
				if (
					v.state !== state &&
					[
						"failed",
						"completed",
						"partial",
						"indeterminate",
						"expired",
						"cancelled",
					].includes(v.state)
				)
					throw new Error(`unexpected ${v.state}: ${v.code}`);
				return v.state === state;
			},
			{ timeout: 2000 },
		);
		return status(id);
	};
	const answer = async (
		id: string,
		extra: Record<string, unknown>,
		source?: unknown,
	) => {
		const v = status(id);
		const r = await store.write((db) =>
			service.answerInTransaction(
				db,
				owner,
				{
					runId: id,
					conversationId,
					questionId: v.question?.id,
					generation: v.generation,
					expectedRevision: v.revision,
					...extra,
				},
				source,
			),
		);
		service.afterCommit();
		return r;
	};
	const cancel = async (id: string) => {
		const v = await store.write((db) =>
			service.cancelInTransaction(db, owner, conversationId, id),
		);
		service.afterCommit();
		return v;
	};
	const close = async () => {
		await service.close();
		await queue.close(100);
		await store.close();
		if (!options.directory) rmSync(dir, { recursive: true, force: true });
	};
	if (options.startQueue !== false) queue.start();
	return {
		dir,
		store,
		queue,
		service,
		driver,
		files,
		encoder,
		start,
		status,
		wait,
		answer,
		cancel,
		close,
		calls,
		owner,
		conversationId,
	};
}
