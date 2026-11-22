import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture } from "../../domains/markdown/test/workspace.fixture";
import {
	createMarkdown,
	createMarkdownResourceAdapter,
	migrations as markdownMigrations,
} from "../../domains/markdown";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import { openStore } from "../../infrastructure/sqlite";
import { sha256Hex } from "../../infrastructure/digest";
import { waitFor } from "../../infrastructure/wait-for";
import type { DesignInput } from "eumenes-agency/agenda/runtime";
import type {
	SupervisionDesignBinding,
	SupervisionEvidence,
} from "../../domains/development-supervision/contracts";
import { createSupervisionDesigns } from "./supervision-design";

const evidence: SupervisionEvidence = {
	kind: "memory",
	ref: "memory:fixture:1",
	id: "fixture",
	digest: "fixture-digest",
	revision: "1",
};
const input: DesignInput = {
	purpose: "集計の結果を既存の入口で確認する",
	workspace: "/fixture",
	analysis: "固定データと入口を確認した",
	brief: { task: "集計の確認", prompt: "固定データで件数を照合する" },
	memory: [{ id: evidence.id, text: "既定のフィルターを使う" }],
	notes: [],
};
const output = {
	status: "ready",
	title: "集計の確認",
	summary: "固定データで確認",
	markdown: "# 集計の確認\n\n固定入力で件数を照合する。",
	sources: [`memory:${evidence.id}`],
	missing: null,
};

test("the published Agency contract rejects an unavailable citation and unversioned design input", async () => {
	const h = fixture();
	const design = createSupervisionDesigns({
		markdown: h.service,
		bindingInTransaction: () => null,
		infer: async () => ({ ...output, sources: ["note:invented"] }),
	});
	await expect(
		design.prepare(input, [], AbortSignal.timeout(1000)),
	).rejects.toThrow("supervision_design_evidence_mismatch");
	await expect(
		design.prepare(input, [evidence], AbortSignal.timeout(1000)),
	).rejects.toThrow("design_source_not_available");
});

test("a lost design-save claim recovers with the same digest and stays unreadable after forgetting", async () => {
	const h = fixture();
	let binding: SupervisionDesignBinding | null = null;
	let active = true;
	const ports = {
		bindingInTransaction: (_db: unknown, id: string, parent: string) =>
			active && binding?.documentId === id && binding.parentId === parent
				? binding
				: null,
		infer: async () => output,
	};
	const design = createSupervisionDesigns({ ...ports, markdown: h.service });
	const prepared = await design.prepare(
		input,
		[evidence],
		AbortSignal.timeout(1000),
	);
	if (prepared.kind !== "ready") throw Error("design_not_ready");
	const own: SupervisionDesignBinding = {
		parentId: "parent",
		conversationId: "active-conversation",
		sourceRunId: "user-run",
		generation: 0,
		revision: 1,
		documentId: crypto.randomUUID(),
		digest: sha256Hex(output.markdown),
		evidence: [evidence],
	};
	const bad = { ...own, parentId: "another-parent" };
	await h.store.write((db) => {
		binding = own;
		expect(() => design.startInTransaction(db, bad, prepared)).toThrow(
			"supervision_design_binding_mismatch",
		);
		design.startInTransaction(db, own, prepared);
		expect(design.stateInTransaction(db, own)).toBe("pending");
	});
	const job = h.queue.list({ scope: "markdown" }).items[0]!;
	expect(job.state).toBe("queued");
	await h.queue.close(20);
	await h.store.close();
	const crash = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "supervision-design-crash.fixture.ts"),
			h.file,
			job.kind,
		],
		{
			stdout: "ignore",
			stderr: "inherit",
			timeout: 5000,
		},
	);
	expect(await crash.exited).toBe(72);

	const store = openStore(h.file, [...queueMigrations, ...markdownMigrations]);
	let now = Date.now();
	const queue = createQueue(store, { now: () => now, random: () => 0 });
	try {
		const markdown = createMarkdown({ store, queue, archive: h.archive });
		const recovered = createSupervisionDesigns({ ...ports, markdown });
		const resources = createMarkdownResourceAdapter(
			store,
			undefined,
			markdown.generated,
		);
		const target = `generated-${own.documentId}`;
		expect(queue.get(job.id)?.state).toBe("running");
		expect(await queue.recover()).toBe(1);
		expect(queue.get(job.id)?.state).toBe("retry_wait");
		expect(store.read((db) => recovered.stateInTransaction(db, own))).toBe(
			"pending",
		);
		now += 5_000;
		queue.start();
		await waitFor(
			() =>
				store.read((db) => recovered.stateInTransaction(db, own)) === "ready",
		);
		expect(queue.get(job.id)).toMatchObject({ attempt: 2, state: "completed" });
		const accepted = store.read((db) => recovered.readInTransaction(db, own));
		expect(accepted).toMatchObject({
			documentId: own.documentId,
			markdown: output.markdown,
			digest: own.digest,
		});
		expect(h.calls()).toBe(0);
		expect(store.read((db) => recovered.readInTransaction(db, bad))).toBeNull();
		expect(await resources.read(target, AbortSignal.timeout(1000))).toEqual({
			text: output.markdown,
		});
		active = false;
		expect(store.read((db) => recovered.readInTransaction(db, own))).toBeNull();
		expect(
			store.read((db) => resources.getInTransaction(db, target)),
		).toBeNull();
		await expect(
			resources.read(target, AbortSignal.timeout(1000)),
		).rejects.toThrow("item_not_found");
		await store.write((db) =>
			recovered.cancelInTransaction(db, own.documentId, true),
		);
		expect(
			store.read((db) =>
				markdown.generated.originalInTransaction(db, own.documentId),
			),
		).toBeNull();
	} finally {
		await queue.close(20);
		await store.close();
	}
});
