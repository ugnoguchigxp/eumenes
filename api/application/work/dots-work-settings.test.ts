import { createTaskReportDelivery } from "./task-report-delivery";
import { expect, test } from "bun:test";
import { delegationFixture } from "./dots-delegation.fixture";
test("registered fields apply once from the UI, conflicts retain settings and conversations cannot edit them", async () => {
	const f = await delegationFixture();
	try {
		const field = f.store.readSnapshot((db) =>
			f.caps.documentInTransaction(db, "artifact:settings.dots@5"),
		)!.document as { fields: Array<{ fieldId: string; path: string }> };
		const id = field.fields.find(
				(x) => x.path === "$.settings.enabled",
			)!.fieldId,
			requestId = crypto.randomUUID(),
			ui = {
				kind: "ui" as const,
				scope: "default",
				actionRequestId: requestId,
			};
		const input = {
			expectedRevision: 1,
			changes: [{ fieldId: id, value: "false" }],
		};
		const first = await f.invoke("dots.settings-apply", input, requestId, ui);
		expect(first.receipt).toMatchObject({ operation: "settings", revision: 2 });
		expect(
			(await f.invoke("dots.settings-apply", input, requestId, ui)).replay,
		).toBe(true);
		expect(
			f.store.readSnapshot(f.work.settings.inTransaction).settings.enabled,
		).toBe(false);
		expect(f.store.readSnapshot(f.adapter.availableInTransaction)).toBe(false);
		expect(
			f.store.readSnapshot((db) =>
				f.adapter.artifactAvailableInTransaction!(db),
			),
		).toBe(true);
		await expect(f.invoke("dots.settings-apply", input)).rejects.toThrow(
			"dots_permission_denied",
		);
		await expect(
			f.invoke("dots.settings-apply", input, crypto.randomUUID(), ui),
		).rejects.toThrow("revision_conflict");
		await expect(
			f.invoke(
				"dots.settings-apply",
				{
					expectedRevision: 2,
					changes: [{ fieldId: "unregistered", value: "true" }],
				},
				crypto.randomUUID(),
				ui,
			),
		).rejects.toThrow("field_not_registered");
	} finally {
		await f.close();
	}
});
test("a project-role change is an explicit revision-checked UI operation, not an automatic startup upgrade", async () => {
	const f = await delegationFixture();
	try {
		const { revision, ...fields } = f.project;
		const old = await f.dots.config.configureProject({
			...fields,
			expectedRevision: revision,
			capabilityRevisionId: "package:dots.orchestrate@2",
		});
		expect(f.store.readSnapshot(f.adapter.availableInTransaction)).toBe(false);
		const requestId = crypto.randomUUID(),
			ui = {
				kind: "ui" as const,
				scope: "default",
				actionRequestId: requestId,
			};
		const input = {
			projectRef: old.ref,
			expectedRevision: old.revision,
			capabilityRevisionId: "package:dots.orchestrate@4",
		};
		await expect(f.invoke("dots.project-role", input)).rejects.toThrow(
			"dots_permission_denied",
		);
		await expect(
			f.invoke(
				"dots.project-role",
				{ ...input, expectedRevision: old.revision - 1 },
				requestId,
				ui,
			),
		).rejects.toThrow("revision_conflict");
		await f.invoke("dots.project-role", input, requestId, ui);
		expect(
			(await f.invoke("dots.project-role", input, requestId, ui)).replay,
		).toBe(true);
		expect(f.store.readSnapshot(f.adapter.availableInTransaction)).toBe(true);
	} finally {
		await f.close();
	}
});

test("disabled conversation delivery keeps the report inspectable without appending a chat message", async () => {
	const f = await delegationFixture();
	try {
		const started = await f.invoke("dots.start", f.start),
			id = (started.receipt as { value: { taskId: string } }).value.taskId;
		await f.store.write((db) => {
			f.reports.appendInTransaction(db, id, "delivery-fixture", {
				kind: "progress",
				summary: "保存された報告",
				facts: [],
				limitations: [],
				evidenceRefs: [],
				snapshotHash: null,
				questionId: null,
			});
			const saved = f.work.settings.inTransaction(db);
			f.work.settings.applyInTransaction(db, {
				requestId: crypto.randomUUID(),
				expectedRevision: saved.revision,
				digest: "disable-delivery",
				settings: { ...saved.settings, showInConversation: false },
			});
			createTaskReportDelivery(
				f.reports,
				f.tasks,
				f.conversation,
				(tx, t) =>
					t.kind !== "orchestration" ||
					f.work.settings.inTransaction(tx).settings.showInConversation,
			)(db);
		});
		expect(
			f.conversation
				.get("conversation")
				.messages.filter((m) => m.role === "assistant"),
		).toHaveLength(0);
		expect(f.reports.list(id).items).toHaveLength(1);
		expect(
			f.store.readSnapshot((db) => f.reports.pendingInTransaction(db)),
		).toHaveLength(0);
	} finally {
		await f.close();
	}
});
