import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createActionRequests,
	createAdapterRegistry,
	type AdapterResult,
} from "../domains/tool-runtime";
import {
	createDotsAdapter,
	describeDotsAdapter,
	DOTS_ADAPTER_REF,
} from "./dots-adapter";
import { dotsFixture } from "./dots-fixture";
import {
	describeServiceTestsAdapter,
	SERVICE_TESTS_ADAPTER_REF,
} from "./service-tests-adapter";
import { bundleHostOf, hostAdapterDescriptions } from "./toolchain-adapters";

type Bundle = {
	artifacts: Array<{
		id: string;
		revision: number;
		actionBindings: Array<{
			actionId: string;
			source: string;
			confidentialFields?: string[];
			rowInput?: Record<string, string | { literal: unknown }>;
		}>;
		collections: Array<{
			source: string;
			rowKey: string;
			rowActions: Array<{
				actionId: string;
				form?: {
					fields: Array<{ fieldId: string; defaultValue?: string }>;
					prefill: Record<string, string>;
				};
			}>;
			create?: { fields: Array<{ fieldId: string; defaultValue?: string }> };
		}>;
	}>;
};
const bundle = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			"../domains/capabilities/bundles/settings-dots.bundle.json",
		),
		"utf8",
	),
) as Bundle;
const artifact = bundle.artifacts[0]!;
const ARTIFACT = `artifact:${artifact.id}@${artifact.revision}`;
const HEX64 = /^[0-9a-f]{64}$/;
/** The receipt the screen got in an accepted action's result. */
const receiptOf = <T>(sent: {
	request: { result?: { receipt?: unknown } };
}): T => sent.request.result!.receipt as T;

const host = () =>
	bundleHostOf([
		...hostAdapterDescriptions,
		{ ref: DOTS_ADAPTER_REF, describe: describeDotsAdapter },
		{ ref: SERVICE_TESTS_ADAPTER_REF, describe: describeServiceTestsAdapter },
	]);

let fixture: Awaited<ReturnType<typeof dotsFixture>> | undefined;
afterEach(async () => {
	await fixture?.close();
	fixture = undefined;
});

async function setup(options: { now?: () => number } = {}) {
	const f = await dotsFixture();
	fixture = f;
	const adapter = createDotsAdapter(
		{
			config: f.dots.config,
			events: f.events,
			packages: f.capabilities,
			tasks: f.tasks,
		},
		options,
	);
	await f.store.write((db) =>
		f.capabilities.importBundleInTransaction(db, bundle, host()),
	);
	const ledger = createActionRequests({
		store: f.store,
		capabilities: f.capabilities,
		registry: createAdapterRegistry([adapter]),
		scope: "test-scope",
	});
	const rows = <T>(source: string) =>
		(ledger.source(ARTIFACT, source).data as T[]) ?? [];
	/** The input the Web host builds: form values plus the registered literals and row paths. */
	function webInput(
		actionId: string,
		form: Record<string, unknown> = {},
		row?: Record<string, unknown>,
	) {
		const binding = artifact.actionBindings.find(
			(a) => a.actionId === actionId,
		)!;
		const input: Record<string, unknown> = { ...form };
		for (const [key, source] of Object.entries(binding.rowInput ?? {}))
			input[key] ??=
				typeof source === "string"
					? row![source.slice("$row.".length)]
					: source.literal;
		return { binding, input };
	}
	async function send(
		actionId: string,
		form?: Record<string, unknown>,
		row?: Record<string, unknown>,
		eventId = crypto.randomUUID(),
	) {
		const { binding, input } = webInput(actionId, form, row);
		const now = Date.now();
		return ledger.submit({
			version: 1,
			eventId,
			eventCreatedAt: new Date(now).toISOString(),
			eventExpiresAt: new Date(now + 60_000).toISOString(),
			artifactId: "tab-1",
			artifactRevisionId: ARTIFACT,
			source: binding.source,
			sourceRevision: 0,
			actionId,
			scopeRef: ledger.scopeRef,
			input,
		});
	}
	const rowOf = (source: string, key: string, value: unknown) => {
		const row = rows<Record<string, unknown>>(source).find(
			(r) => r[key] === value,
		);
		if (!row) throw new Error(`no row ${String(value)}`);
		return row;
	};
	return { f, adapter, ledger, rows, send, rowOf };
}
type Harness = Awaited<ReturnType<typeof setup>>;

const invoke = (
	h: Harness,
	operationName: string,
	input: unknown,
	origin: "ui" | "conversation" = "ui",
) => {
	const requestId = crypto.randomUUID();
	return h.f.store.write((db) =>
		h.adapter.invokeInTransaction(db, {
			operationName,
			input,
			requestId,
			issuedAt: new Date().toISOString(),
			origin:
				origin === "conversation"
					? {
							kind: "conversation",
							owner: {} as never,
							runId: "r",
							conversationId: "c",
							messageId: "m",
						}
					: { kind: "ui", scope: "scope", actionRequestId: requestId },
		}),
	);
};
const codeOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return "no_error";
	} catch (error) {
		return (error as Error).message;
	}
};
const ops = (...enabled: string[]) =>
	Object.fromEntries(
		[
			"opRead",
			"opCreateSession",
			"opContinueSession",
			"opEdit",
			"opCheck",
			"opCommit",
			"opPush",
			"opPublish",
			"opSend",
		].map((key) => [key, enabled.includes(key)]),
	);

test("the dots bundle passes a dry-run import against this host, and is not accepted by a host without the adapter", async () => {
	const f = await dotsFixture();
	fixture = f;
	const dry = (h: ReturnType<typeof host>) =>
		f.store.write((db) =>
			f.capabilities.importBundleInTransaction(db, bundle, h, { dryRun: true }),
		);
	expect((await dry(host())).issues).toEqual([]);
	// dots turned off: the adapter is not registered and the whole bundle is refused.
	const without = bundleHostOf(
		hostAdapterDescriptions.filter((d) => d.ref !== DOTS_ADAPTER_REF),
	);
	const refused = (await dry(without)).issues;
	expect(refused.length).toBeGreaterThan(0);
	expect(refused.map((i) => i.code)).toContain("unregistered_adapter");
});

test("describe lists the fourteen dots writes and the seven queries", () => {
	const d = describeDotsAdapter();
	expect(
		Object.fromEntries(
			[...d.operations].map(([name, op]) => [name, op.effect]),
		),
	).toEqual(
		Object.fromEntries(
			[
				"dots.connection-create",
				"dots.connection-update",
				"dots.connection-enabled",
				"dots.project-create",
				"dots.project-update",
				"dots.project-enabled",
				"dots.package-create",
				"dots.package-update",
				"dots.package-enabled",
				"dots.task-create",
				"dots.task-start",
				"dots.task-stop",
				"dots.task-answer",
				"dots.task-forget",
			].map((name) => [name, "write"]),
		),
	);
	expect(d.queries.size).toBe(7);
	expect(d.availability).toBe("availability:dots@1");
});

test("the bundle restores the legacy defaults, edits from prefilled rows, and has no generated-id literal or secret field", () => {
	const text = JSON.stringify(bundle);
	expect(text).not.toContain("$uuid");
	expect(
		artifact.actionBindings.every((a) => a.confidentialFields === undefined),
	).toBe(true);
	const bySource = (source: string) =>
		artifact.collections.find((c) => c.source === source)!;
	const connections = bySource("dots-connections");
	const projects = bySource("dots-projects");
	const defaults = (
		fields: Array<{ fieldId: string; defaultValue?: string }>,
	) =>
		Object.fromEntries(
			fields
				.filter((f) => f.defaultValue !== undefined)
				.map((f) => [f.fieldId, f.defaultValue]),
		);
	expect(defaults(connections!.create!.fields)).toEqual({
		title: "dots",
		enabled: "true",
	});
	expect(defaults(projects!.create!.fields)).toMatchObject({
		enabled: "true",
		hostId: "local",
		environment: "local",
		opRead: "true",
		opCreateSession: "true",
		opEdit: "true",
		opCheck: "true",
	});
	expect(defaults(projects!.create!.fields)).not.toHaveProperty("opSend");
	for (const collection of artifact.collections) {
		const edit = collection.rowActions.find((a) =>
			a.actionId.endsWith("-edit"),
		);
		if (!edit) continue;
		const binding = artifact.actionBindings.find(
			(a) => a.actionId === edit.actionId,
		)!;
		// The guard comes from the row; the form is filled from the row and has no defaults.
		expect(JSON.stringify(binding.rowInput)).toMatch(
			/\$row\.(revision|stateToken)/,
		);
		expect(Object.keys(edit.form!.prefill).sort()).toEqual(
			edit.form!.fields.map((f) => f.fieldId).sort(),
		);
		expect(edit.form!.fields.some((f) => f.defaultValue !== undefined)).toBe(
			false,
		);
	}
});

test("a new connection shows its local token once, in the creating action's settled result only", async () => {
	const h = await setup();
	const eventId = crypto.randomUUID();
	const form = { title: "MacBook", enabled: true };
	const created = await h.send("connection-create", form, undefined, eventId);
	expect(created.request.status).toBe("accepted");
	const receipt = receiptOf<{
		id: string;
		revision: number;
		created: boolean;
		localToken: string;
	}>(created);
	expect(receipt).toMatchObject({
		kind: "connection",
		revision: 1,
		created: true,
		// The id is derived by the adapter from the request, not sent by the client.
		id: eventId,
	});
	expect(receipt.localToken).toMatch(HEX64);
	expect(h.f.dots.config.authenticateLocal(receipt.localToken).id).toBe(
		receipt.id,
	);

	// Neither a re-read nor a resend of the same event can show it again.
	expect(JSON.stringify(h.ledger.get(eventId))).not.toContain(
		receipt.localToken,
	);
	const again = await h.send("connection-create", form, undefined, eventId);
	expect(again.replay).toBe(true);
	expect(JSON.stringify(again.request)).not.toContain(receipt.localToken);

	// Nothing stored by the ledger, no source and no domain row has the plaintext.
	const stored = h.f.store.read((db) =>
		JSON.stringify([
			db
				.query(
					"SELECT canonical_input_json,result_json FROM tool_action_requests",
				)
				.all(),
			db.query("SELECT data_json,local_token_hash FROM dots_connections").all(),
		]),
	);
	expect(stored).not.toContain(receipt.localToken);
	for (const source of ["dots-connections", "dots-projects", "dots-packages"])
		expect(JSON.stringify(h.ledger.source(ARTIFACT, source))).not.toContain(
			receipt.localToken,
		);
	expect(
		h.f.store.read((db) =>
			db.query("SELECT count(*) AS n FROM tool_action_requests").get(),
		),
	).toEqual({ n: 1 });
});

test("the token handoff expires and is read at most once", async () => {
	let now = 1_000_000;
	const h = await setup({ now: () => now });
	const result: AdapterResult = await invoke(h, "dots.connection-create", {
		title: "temp",
		enabled: true,
	});
	expect(JSON.stringify(result)).not.toMatch(/localToken/);
	const operationId = result.receiptRef.operationId;
	now += 61_000;
	expect(h.adapter.readInTransaction({} as never, operationId)).toBeNull();
	const fresh: AdapterResult = await invoke(h, "dots.connection-create", {
		title: "temp 2",
		enabled: true,
	});
	const first = h.adapter.readInTransaction(
		{} as never,
		fresh.receiptRef.operationId,
	)!;
	expect((first.receipt as { localToken: string }).localToken).toMatch(HEX64);
	expect(first.receiptRef.digest).toBe(fresh.receiptRef.digest);
	expect(
		h.adapter.readInTransaction({} as never, fresh.receiptRef.operationId),
	).toBeNull();
});

test("a connection is edited from its row with the row's revision, switched on and off, and a stale guard is a revision_conflict", async () => {
	const h = await setup();
	const row = () => h.rowOf("dots-connections", "id", "other");
	expect(row()).toMatchObject({
		title: "other",
		revision: 1,
		enabled: true,
		mode: "ローカル専用",
		endpoint: "/mcp/dots/other",
		subscription: "未登録または期限切れ",
		oauthIssuer: "",
	});
	const disabled = await h.send("connection-disable", {}, row());
	expect(disabled.request.status).toBe("accepted");
	expect(receiptOf(disabled)).toMatchObject({
		kind: "connection",
		created: false,
	});
	expect(receiptOf(disabled)).not.toHaveProperty("localToken");
	expect(row()).toMatchObject({ enabled: false, revision: 2 });
	// A row read before the change carries a stale guard; nothing is filled in for it.
	const stale = await h.send(
		"connection-enable",
		{},
		{ ...row(), revision: 1 },
	);
	expect(stale.request.errorCode).toBe("revision_conflict");
	expect((await h.send("connection-enable", {}, row())).request.status).toBe(
		"accepted",
	);

	const edit = { title: "renamed", enabled: true };
	const staleEdit = await h.send("connection-edit", edit, {
		...row(),
		revision: 1,
	});
	expect(staleEdit.request.errorCode).toBe("revision_conflict");
	expect(row().title).toBe("other");
	const renamed = await h.send("connection-edit", edit, row());
	expect(renamed.request.status).toBe("accepted");
	expect(receiptOf(renamed)).not.toHaveProperty("localToken");
	expect(row()).toMatchObject({ title: "renamed", revision: 4 });
	// A row for a connection that is gone cannot be edited, and an edit cannot create one.
	expect(
		(await h.send("connection-edit", edit, { id: "nothing", revision: 1 }))
			.request.errorCode,
	).toBe("dots_not_found");
	expect(h.f.dots.config.list().connections).toHaveLength(2);
});

test("OAuth needs all four values, https URLs, and cannot move to another owner afterwards", async () => {
	const h = await setup();
	const oauth = {
		oauthIssuer: "https://auth.example.com",
		oauthJwksUrl: "https://auth.example.com/jwks.json",
		oauthResource: "https://eumenes.example.com/mcp/dots/remote",
		oauthSubject: "user-1",
	};
	const base = { title: "remote", enabled: true };
	expect(
		(
			await h.send("connection-create", {
				...base,
				oauthIssuer: oauth.oauthIssuer,
			})
		).request.errorCode,
	).toBe("invalid_input");
	expect(
		(
			await h.send("connection-create", {
				...base,
				...oauth,
				oauthJwksUrl: "http://auth.example.com/jwks.json",
			})
		).request.errorCode,
	).toBe("invalid_input");
	const created = await h.send("connection-create", { ...base, ...oauth });
	expect(created.request.status).toBe("accepted");
	const id = receiptOf<{ id: string }>(created).id;
	const row = () => h.rowOf("dots-connections", "id", id);
	expect(row()).toMatchObject({ mode: "OAuth", ...oauth });
	// The prefilled values of the row go back unchanged, so editing the title alone works.
	const prefill = Object.fromEntries(
		Object.keys(oauth).map((key) => [key, row()[key]]),
	);
	expect(
		(
			await h.send(
				"connection-edit",
				{ ...base, ...prefill, title: "remote 2" },
				row(),
			)
		).request.status,
	).toBe("accepted");
	const moved = await h.send(
		"connection-edit",
		{ ...base, ...prefill, oauthSubject: "someone-else" },
		row(),
	);
	expect(moved.request.errorCode).toBe("dots_owner_immutable");
	const dropped = await h.send("connection-edit", base, row());
	expect(dropped.request.errorCode).toBe("dots_owner_immutable");
});

test("projects are created, edited from their rows without changing the connection, and switched on and off", async () => {
	const h = await setup();
	const form = {
		title: "web app",
		connectionRef: "dots",
		nativeProjectId: "codex-web",
		hostId: "local",
		environment: "local",
		enabled: true,
		...ops("opRead", "opEdit"),
	};
	const created = await h.send("project-create", form);
	expect(created.request.status).toBe("accepted");
	const ref = receiptOf<{ ref: string }>(created).ref;
	expect(ref).toBe(created.request.eventId);
	const row = () => h.rowOf("dots-projects", "ref", ref);
	expect(row()).toMatchObject({
		title: "web app",
		connection: "fixture",
		capability: "標準の調整担当",
		capabilityRevisionId: "package:dots.orchestrate@2",
		environment: "local",
		environmentLabel: "ローカル",
		operations: "参照・編集",
		opRead: true,
		opEdit: true,
		opSend: false,
		revision: 1,
	});
	// No operation allowed and a missing connection are refused; create never overwrites.
	expect(
		(await h.send("project-create", { ...form, ...ops() })).request.errorCode,
	).toBe("invalid_input");
	expect(
		(await h.send("project-create", { ...form, connectionRef: "nothing" }))
			.request.errorCode,
	).toBe("dots_not_found");
	const { connectionRef: _connection, ...edit } = form;
	const staleEdit = await h.send(
		"project-edit",
		{ ...edit, environment: "cloud" },
		{ ...row(), revision: 0 },
	);
	expect(staleEdit.request.errorCode).toBe("revision_conflict");
	const updated = await h.send(
		"project-edit",
		{
			...edit,
			environment: "cloud",
			...ops("opRead", "opCheck", "opSend"),
		},
		row(),
	);
	expect(updated.request.status).toBe("accepted");
	expect(row()).toMatchObject({
		environmentLabel: "クラウド",
		operations: "参照・検証・外部への送信",
		revision: 2,
	});
	expect(
		h.f.dots.config.list().projects.find((p) => p.ref === ref),
	).toMatchObject({ connectionRef: "dots" });
	expect((await h.send("project-disable", {}, row())).request.status).toBe(
		"accepted",
	);
	expect(row()).toMatchObject({ enabled: false, revision: 3 });
	expect(
		(await h.send("project-disable", {}, { ...row(), revision: 1 })).request
			.errorCode,
	).toBe("revision_conflict");
	expect((await h.send("project-enable", {}, row())).request.status).toBe(
		"accepted",
	);
	expect(
		h.f.dots.config.list().projects.find((p) => p.ref === ref),
	).toMatchObject({
		enabled: true,
		allowedOperations: ["read", "check", "send"],
	});
});

test("a user package is created, edited from its row with the row's token, chosen for a project, and switched on and off", async () => {
	const h = await setup();
	const form = {
		title: "調査担当",
		summary: "コードを読んで報告する",
		profile: "根拠を示して報告する",
		enabled: true,
		skill1Title: "手順",
		skill1Body: "読んでから報告する",
	};
	const created = await h.send("package-create", form);
	expect(created.request.status).toBe("accepted");
	const id = receiptOf<{ id: string }>(created).id;
	expect(id).toMatch(/^dots\.user\.[a-f0-9]{32}$/);
	const row = () => h.rowOf("dots-packages", "id", id);
	expect(row()).toMatchObject({
		title: "調査担当",
		revision: 1,
		skillCount: 1,
		enabled: true,
		profile: "根拠を示して報告する",
		skill1Title: "手順",
		skill2Title: "",
	});
	// A half-filled second Skill is refused; a full one is kept.
	expect(
		(await h.send("package-edit", { ...form, skill2Title: "確認" }, row()))
			.request.errorCode,
	).toBe("invalid_input");
	const staleRow = row();
	const updated = await h.send(
		"package-edit",
		{ ...form, skill2Title: "確認", skill2Body: "結果を確かめる" },
		row(),
	);
	expect(updated.request.status).toBe("accepted");
	expect(row()).toMatchObject({ revision: 2, skillCount: 2 });
	// The token of the older row is stale: the edit is a conflict and saves nothing.
	const stale = await h.send(
		"package-edit",
		{ ...form, title: "古い" },
		staleRow,
	);
	expect(stale.request.errorCode).toBe("revision_conflict");
	expect(row().title).toBe("調査担当");
	const options = h.ledger.source(ARTIFACT, "dots-capability-options").data as {
		options: Array<{ value: string; label: string }>;
	};
	expect(options.options).toEqual([
		{ value: "package:dots.orchestrate@2", label: "標準の調整担当" },
		{ value: `package:${id}@2`, label: "調査担当（版 2）" },
	]);
	const project = await h.send("project-create", {
		title: "uses package",
		connectionRef: "dots",
		capabilityRevisionId: `package:${id}@2`,
		nativeProjectId: "p",
		hostId: "local",
		environment: "local",
		enabled: true,
		...ops("opRead"),
	});
	expect(project.request.status).toBe("accepted");
	const before = row();
	expect((await h.send("package-disable", {}, before)).request.status).toBe(
		"accepted",
	);
	expect(row()).toMatchObject({ enabled: false, revision: 3 });
	expect((await h.send("package-enable", {}, before)).request.errorCode).toBe(
		"revision_conflict",
	);
	expect((await h.send("package-enable", {}, row())).request.status).toBe(
		"accepted",
	);
	expect(row()).toMatchObject({ enabled: true, revision: 4, skillCount: 2 });
	expect(
		(
			await h.send("package-edit", form, {
				id: "dots.user.nothing",
				stateToken: "t",
			})
		).request.errorCode,
	).toBe("dots_not_found");
});

test("sources give rows with labels and option lists, without secrets", async () => {
	const h = await setup();
	await h.send("task-create", taskForm);
	await h.send("package-create", {
		title: "担当",
		summary: "概要",
		profile: "指示",
		enabled: true,
		skill1Title: "手順",
		skill1Body: "本文",
	});
	expect(h.ledger.source(ARTIFACT, "dots-connection-options").data).toEqual({
		options: [
			{ value: "dots", label: "fixture" },
			{ value: "other", label: "other" },
		],
	});
	const projects = h.rows<Record<string, unknown>>("dots-projects");
	expect(projects).toHaveLength(1);
	expect(Object.keys(projects[0]!).sort()).toEqual(
		[
			"capability",
			"capabilityRevisionId",
			"connection",
			"enabled",
			"environment",
			"environmentLabel",
			"hostId",
			"nativeProjectId",
			"operations",
			"ref",
			"revision",
			"title",
			...Object.keys(ops()),
		].sort(),
	);
	// Every collection row key names a field of its source, and every edit form is filled
	// from fields the rows really have.
	for (const collection of artifact.collections) {
		const [first] = h.rows<Record<string, unknown>>(collection.source);
		expect(first).toHaveProperty(collection.rowKey);
		for (const action of collection.rowActions)
			for (const path of Object.values(action.form?.prefill ?? {}))
				expect(first).toHaveProperty(path.slice("$row.".length));
	}
});

test("operations are for screens only, validate their input, and unknown ones are unavailable", async () => {
	const h = await setup();
	const input = { title: "x", enabled: true };
	expect(
		await codeOf(invoke(h, "dots.connection-create", input, "conversation")),
	).toBe("capability_unavailable");
	expect(await codeOf(invoke(h, "dots.nothing", input))).toBe(
		"capability_unavailable",
	);
	expect(
		await codeOf(invoke(h, "dots.connection-create", { ...input, extra: 1 })),
	).toBe("invalid_input");
	expect(
		await codeOf(
			invoke(h, "dots.connection-enabled", {
				id: "dots",
				expectedRevision: "1",
				enabled: true,
			}),
		),
	).toBe("invalid_input");
	// An update without its guard is refused, not completed from the current value.
	expect(
		await codeOf(invoke(h, "dots.connection-update", { id: "dots", ...input })),
	).toBe("invalid_input");
	expect(
		await codeOf(
			invoke(h, "dots.package-enabled", {
				id: "dots.user.nothing",
				expectedToken: "t",
				enabled: true,
			}),
		),
	).toBe("dots_not_found");
	expect(h.f.dots.config.list().connections.map((c) => c.title)).toEqual([
		"fixture",
		"other",
	]);
});

test("a ledger without the dots adapter refuses every dots action (dots turned off)", async () => {
	const f = await dotsFixture();
	fixture = f;
	await f.store.write((db) =>
		f.capabilities.importBundleInTransaction(db, bundle, host()),
	);
	const ledger = createActionRequests({
		store: f.store,
		capabilities: f.capabilities,
		registry: createAdapterRegistry([]),
		scope: "test-scope",
	});
	const now = Date.now();
	const attempt = ledger.submit({
		version: 1,
		eventId: crypto.randomUUID(),
		eventCreatedAt: new Date(now).toISOString(),
		eventExpiresAt: new Date(now + 60_000).toISOString(),
		artifactId: "tab-1",
		artifactRevisionId: ARTIFACT,
		source: "dots-connections",
		sourceRevision: 0,
		actionId: "connection-create",
		scopeRef: ledger.scopeRef,
		input: { title: "x", enabled: true },
	});
	await expect(attempt).rejects.toMatchObject({ status: 503 });
	expect(ledger.artifacts().map((a) => a.artifactRevisionId)).not.toContain(
		ARTIFACT,
	);
	expect(f.dots.config.list().connections.map((c) => c.id)).toEqual([
		"dots",
		"other",
	]);
});

const taskForm = {
	projectRef: "project",
	title: "調査",
	request: "コードを読んで報告する",
	completionConditions: "テストが通る\n  \n報告がある",
	maxSessions: 2,
};

test("delegated work is requested from an enabled project, listed with what it accepts, and commanded with the row's revision", async () => {
	const h = await setup();
	expect(h.rows("dots-tasks")).toEqual([]);
	expect(h.ledger.source(ARTIFACT, "dots-task-project-options").data).toEqual({
		options: [{ value: "project", label: "fixture" }],
	});
	const created = await h.send("task-create", taskForm);
	expect(created.request.status).toBe("accepted");
	const taskId = receiptOf<{ taskId: string; kind: string }>(created).taskId;
	const row = () => h.rowOf("dots-tasks", "id", taskId);
	expect(row()).toMatchObject({
		title: "調査",
		state: "queued",
		stateLabel: "受領待ち",
		request: "コードを読んで報告する",
		canStart: false,
		canPause: true,
		canCancel: true,
		canForget: true,
		canAnswer: false,
	});
	// The grant is the project's own: its operations, its connection, two sessions, two hours.
	const saved = h.f.tasks.get(taskId).task;
	expect(saved.kind).toBe("orchestration");
	expect(saved).toMatchObject({
		completionConditions: ["テストが通る", "報告がある"],
		grant: {
			connectionRef: "dots",
			projectRef: "project",
			operations: ["read", "create_session", "edit", "check"],
			maxSessions: 2,
		},
	});
	// A project that is not enabled, or does not exist, cannot be requested.
	expect(
		(await h.send("task-create", { ...taskForm, projectRef: "nothing" }))
			.request.errorCode,
	).toBe("dots_unavailable");
	expect(h.rows("dots-tasks")).toHaveLength(1);

	const stalePause = await h.send("task-pause", {}, { ...row(), revision: 99 });
	expect(stalePause.request.errorCode).toBe("revision_conflict");
	expect(row().state).toBe("queued");
	expect((await h.send("task-pause", {}, row())).request.status).toBe(
		"accepted",
	);
	expect(["stopping", "paused"]).toContain(String(row().state));
	const cancelled = await h.send("task-cancel", {}, row());
	expect(cancelled.request.status).toBe("accepted");
	const forgotten = await h.send("task-forget", {}, row());
	expect(forgotten.request.status).toBe("accepted");
	expect(row()).toMatchObject({ request: "", canForget: false });
});

test("a waiting question is answered from the task's row, with the question the row carried", async () => {
	const h = await setup();
	const r = await h.f.tasks.create(h.f.input());
	const c = h.f.command(r.taskId);
	await h.f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	await h.f.dots.report(
		"dots",
		h.f.report(c, 1, "session_started", { sessions: [h.f.session] }),
	);
	await h.f.dots.report(
		"dots",
		h.f.report(c, 2, "blocked", {
			question: {
				questionId: "question",
				prompt: "対象を選んでください",
				answerType: "choice",
				choices: ["A", "B"],
			},
		}),
	);
	await h.f.tasks.recover();
	await h.f.dots.recover();
	const row = () => h.rowOf("dots-tasks", "id", r.taskId);
	expect(row()).toMatchObject({
		state: "waiting_user",
		question: "対象を選んでください（選択肢: A / B）",
		questionId: "question",
		canAnswer: true,
		canStart: false,
	});
	// A stale row cannot answer; the answer never reaches the task.
	expect(
		(await h.send("task-answer", { answer: "A" }, { ...row(), revision: 0 }))
			.request.errorCode,
	).toBe("revision_conflict");
	expect(
		(await h.send("task-answer", { answer: "A" }, row())).request.status,
	).toBe("accepted");
	expect(row()).toMatchObject({ canAnswer: false, question: "" });
	expect(h.f.command(r.taskId, "answer").snapshot.answer).toEqual({
		questionId: "question",
		text: "A",
	});
});

test("task commands are for delegated work only, validate their input and refuse conversations", async () => {
	const h = await setup();
	const command = { id: "no-such-task", expectedRevision: 0 };
	for (const operation of ["dots.task-start", "dots.task-forget"])
		expect(await codeOf(invoke(h, operation, command))).toBe("task_not_found");
	expect(
		await codeOf(invoke(h, "dots.task-stop", { ...command, intent: "cancel" })),
	).toBe("task_not_found");
	expect(
		await codeOf(invoke(h, "dots.task-stop", { ...command, intent: "other" })),
	).toBe("invalid_input");
	expect(await codeOf(invoke(h, "dots.task-start", { id: "x" }))).toBe(
		"invalid_input",
	);
	expect(
		await codeOf(invoke(h, "dots.task-create", taskForm, "conversation")),
	).toBe("capability_unavailable");
	expect(
		await codeOf(invoke(h, "dots.task-create", { ...taskForm, extra: 1 })),
	).toBe("invalid_input");
	expect(h.f.tasks.list().items).toHaveLength(0);
});
