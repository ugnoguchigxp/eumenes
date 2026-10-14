import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { ActionRequestError, ACTION_POLICY } from "..";
import { ARTIFACT_ID, HUB_ID, OTHER_REF, makeHarness } from "./action-fixture";

let h = makeHarness();
afterEach(async () => {
	await h.close();
});
const fresh = (options?: Parameters<typeof makeHarness>[0]) => {
	h = makeHarness(options);
	return h;
};
const refused = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ActionRequestError) return error;
		throw error;
	}
	throw new Error("expected_refusal");
};
type LedgerRow = {
	status: string;
	error_code: string | null;
	issued_at: string;
	request_id: string;
};
const rows = () =>
	h.store.read((db) =>
		db.query("SELECT * FROM tool_action_requests ORDER BY created_at").all(),
	) as LedgerRow[];

test("execution and acceptance commit together and the adapter receives eventId and host issuedAt", async () => {
	fresh();
	const event = h.event();
	const { request, replay } = await h.service.submit(event);
	expect(replay).toBe(false);
	expect(request.status).toBe("accepted");
	expect(request.result?.outcome).toBe("completed");
	expect(request.result?.receiptRef?.operationId).toBe(`op-${event.eventId}`);
	expect(request.result?.receipt).toEqual({
		operation: "fake.start",
		input: { durationSeconds: 90 },
	});
	expect(request.result?.artifactRefs[0]?.sourceRefs).toEqual([
		{ source: "setup", targetRef: "item-1" },
	]);
	expect(h.invoked).toHaveLength(1);
	expect(h.invoked[0]).toMatchObject({
		requestId: event.eventId,
		operationName: "fake.start",
		issuedAt: new Date(h.time.value).toISOString(),
		origin: { kind: "ui", scope: "default", actionRequestId: event.eventId },
	});
	expect(h.effects()).toBe(1);
	expect(rows()).toHaveLength(1);
	expect(h.calls.afterCommit).toBe(1);
	expect(h.service.get(event.eventId)?.status).toBe("accepted");
});

test("same eventId and digest returns the stored result even after the send window expired", async () => {
	fresh();
	const event = h.event();
	const first = await h.service.submit(event);
	h.time.value += 30 * 3_600_000;
	const again = await h.service.submit(event);
	expect(again.replay).toBe(true);
	expect(again.request.result?.receiptRef).toEqual(
		first.request.result?.receiptRef,
	);
	expect(again.request.result?.receipt).toEqual(first.request.result?.receipt);
	expect(h.effects()).toBe(1);
	expect(h.invoked).toHaveLength(1);
	// issuedAt of the first acceptance is kept in the ledger.
	expect(rows()[0]!.issued_at).toBe(
		new Date(Date.parse("2026-10-13T00:00:00.000Z")).toISOString(),
	);
	expect(h.calls.afterCommit).toBe(1);
});

test("same eventId with a different digest is a 409 recorded in conflicts without overwriting", async () => {
	fresh();
	const event = h.event();
	await h.service.submit(event);
	const error = await refused(
		h.service.submit({
			...event,
			input: { hours: "0", minutes: "2", seconds: "0" },
		}),
	);
	expect([error.code, error.status]).toEqual(["request_conflict", 409]);
	const conflicts = h.store.read((db) =>
		db.query("SELECT * FROM tool_action_request_conflicts").all(),
	);
	expect(conflicts).toHaveLength(1);
	expect(rows()).toHaveLength(1);
	expect(rows()[0]!.status).toBe("accepted");
	expect(h.effects()).toBe(1);
	// A different target or source with the same eventId is a conflict too.
	const other = await refused(
		h.service.submit({
			...event,
			actionId: "cancel",
			source: "item",
			targetRef: "item-1",
			sourceRevision: 3,
			input: {},
		}),
	);
	expect(other.code).toBe("request_conflict");
});

test("time window applies to new requests only", async () => {
	fresh();
	const at = h.time.value;
	const iso = (ms: number) => new Date(ms).toISOString();
	const future = await refused(
		h.service.submit(
			h.event({
				eventCreatedAt: iso(at + 31_000),
				eventExpiresAt: iso(at + 3_600_000),
			}),
		),
	);
	expect([future.code, future.status]).toEqual(["event_time_invalid", 400]);
	const near = await h.service.submit(
		h.event({
			eventCreatedAt: iso(at + 29_000),
			eventExpiresAt: iso(at + 3_600_000),
		}),
	);
	expect(near.request.status).toBe("accepted");
	const old = await refused(
		h.service.submit(
			h.event({
				eventCreatedAt: iso(at - 25 * 3_600_000),
				eventExpiresAt: iso(at - 24 * 3_600_000),
			}),
		),
	);
	expect([old.code, old.status]).toEqual(["event_expired", 410]);
	const expired = await refused(
		h.service.submit(
			h.event({ eventCreatedAt: iso(at - 3_600_000), eventExpiresAt: iso(at) }),
		),
	);
	expect([expired.code, expired.status]).toEqual(["event_expired", 410]);
	const reversed = await refused(
		h.service.submit(
			h.event({ eventCreatedAt: iso(at), eventExpiresAt: iso(at - 1000) }),
		),
	);
	expect(reversed.code).toBe("event_time_invalid");
	const wide = await refused(
		h.service.submit(h.event({ eventExpiresAt: iso(at + 25 * 3_600_000) })),
	);
	expect(wide.code).toBe("event_time_invalid");
	expect(h.effects()).toBe(1);
	expect(rows()).toHaveLength(1);
});

test("forged source, action, artifact, scope and target are refused before anything is saved", async () => {
	fresh();
	const code = async (
		patch: Parameters<typeof h.event>[0],
		status: number,
		expected: string,
	) => {
		const error = await refused(h.service.submit(h.event(patch)));
		expect([error.code, error.status as number]).toEqual([expected, status]);
	};
	await code({ actionId: "nope" }, 404, "action_not_found");
	await code(
		{ source: "item", targetRef: "item-1" },
		400,
		"action_source_mismatch",
	);
	await code({ actionId: "clock" }, 400, "local_action");
	await code({ actionId: "answer" }, 400, "use_interaction_answer");
	await code(
		{ artifactRevisionId: "artifact:other@1" },
		404,
		"artifact_not_found",
	);
	await code({ scopeRef: "scope:forged" }, 403, "scope_mismatch");
	await code({ targetRef: "item-1" }, 400, "target_not_allowed");
	await code(
		{ actionId: "cancel", source: "item", sourceRevision: 3, input: {} },
		400,
		"target_required",
	);
	await code(
		{
			actionId: "cancel",
			source: "item",
			sourceRevision: 3,
			targetRef: "missing",
			input: {},
		},
		404,
		"target_not_found",
	);
	await code({ actionId: "mismatch" }, 503, "effect_mismatch");
	h.setActive(false);
	await code({}, 404, "artifact_not_found");
	h.setActive(true);
	h.setAvailable(() => false);
	await code({}, 503, "adapter_unavailable");
	expect(h.effects()).toBe(0);
	expect(h.ledger()).toBe(0);
	const bad = await refused(h.service.submit({ version: 1 }));
	expect([bad.code, bad.status]).toEqual(["invalid_action_event", 400]);
	const big = await refused(
		h.service.submit({ ...h.event(), input: { text: "x".repeat(20_000) } }),
	);
	expect([big.code, big.status]).toEqual(["payload_too_large", 413]);
});

test("a source revision mismatch is a recorded definitive rejection with no execution", async () => {
	fresh();
	const event = h.event({
		actionId: "cancel",
		source: "item",
		targetRef: "item-1",
		sourceRevision: 2,
		input: {},
	});
	const { request } = await h.service.submit(event);
	expect(request.status).toBe("rejected");
	expect(request.errorCode).toBe("revision_conflict");
	expect(request.result?.outcome).toBe("failed");
	expect(h.effects()).toBe(0);
	expect(rows()[0]!.status).toBe("rejected");
	// The recorded rejection is returned again; it never turns into an execution.
	h.items.set("item-1", 2);
	const again = await h.service.submit(event);
	expect(again.replay).toBe(true);
	expect(again.request.errorCode).toBe("revision_conflict");
	expect(h.effects()).toBe(0);
	// With the current revision a new event runs and receives host-composed target input.
	const ok = await h.service.submit(
		h.event({
			actionId: "cancel",
			source: "item",
			targetRef: "item-1",
			sourceRevision: 2,
			input: {},
		}),
	);
	expect(ok.request.status).toBe("accepted");
	expect(h.invoked.at(-1)?.input).toEqual({
		itemId: "item-1",
		expectedRevision: 2,
	});
	expect(h.calls.afterCommit).toBe(1);
});

test("invalid UI input returns field errors and saves nothing", async () => {
	fresh();
	const adapterErrors = await refused(
		h.service.submit(
			h.event({ input: { hours: "x", minutes: "1", seconds: "-1" } }),
		),
	);
	expect([adapterErrors.code, adapterErrors.status]).toEqual([
		"invalid_input",
		422,
	]);
	expect(adapterErrors.fieldErrors).toEqual([
		{ field: "hours", message: "digits_required" },
		{ field: "seconds", message: "digits_required" },
	]);
	const schemaErrors = await refused(
		h.service.submit(h.event({ input: { hours: 1, minutes: "1" } })),
	);
	expect(schemaErrors.status).toBe(422);
	expect(schemaErrors.fieldErrors?.map((e) => e.field).sort()).toEqual([
		"hours",
		"seconds",
	]);
	// Passes the UI schema and the adapter but not the final operation schema (0 seconds).
	const operation = await refused(
		h.service.submit(
			h.event({ input: { hours: "0", minutes: "0", seconds: "0" } }),
		),
	);
	expect([operation.code, operation.status]).toEqual(["invalid_input", 422]);
	expect(operation.fieldErrors).toEqual([
		{ field: "durationSeconds", message: "too_small" },
	]);
	expect(h.ledger()).toBe(0);
	expect(h.effects()).toBe(0);
	expect(h.invoked).toHaveLength(0);
});

test("domain rejection rolls back its writes but records the rejection; unknown failures abort everything", async () => {
	fresh();
	const rejected = await h.service.submit(
		h.event({ input: { hours: "0", minutes: "0", seconds: "999" } }),
	);
	expect(rejected.request.status).toBe("rejected");
	expect(rejected.request.errorCode).toBe("revision_conflict");
	expect(h.invoked).toHaveLength(1);
	expect(h.effects()).toBe(0);
	expect(rows().map((r) => r.status)).toEqual(["rejected"]);
	expect(h.calls.afterCommit).toBe(0);

	const unknown = h.event({
		input: { hours: "0", minutes: "0", seconds: "998" },
	});
	await expect(h.service.submit(unknown)).rejects.toThrow("Unexpected failure");
	expect(h.effects()).toBe(0);
	expect(rows()).toHaveLength(1);
	expect(h.service.get(unknown.eventId)).toBeNull();
	// The same eventId can be retried after an aborted transaction.
	await expect(h.service.submit(unknown)).rejects.toThrow("Unexpected failure");
});

test("capacity: ordinary actions stop at 4096 rows and cancel operations use the reserved 64", async () => {
	fresh();
	await h.store.write((db) => {
		const insert = db.query(
			`INSERT INTO tool_action_requests(event_id,scope,owner_kind,artifact_revision_id,source,source_revision,action_id,adapter_ref,operation_name,request_id,issued_at,input_digest,binding_digest,event_created_at,event_expires_at,authority_epoch,status,created_at,settled_at)
       VALUES(?,'default','ui','x','s',0,'a','adapter:fake@1','fake.start',?,'t','d','b','c','e',0,'accepted',?,?)`,
		);
		for (let i = 0; i < ACTION_POLICY.capacity; i++) {
			const id = crypto.randomUUID();
			insert.run(id, id, h.time.value, h.time.value);
		}
	});
	const full = await refused(h.service.submit(h.event()));
	expect([full.code, full.status]).toEqual(["action_capacity", 503]);
	expect(h.effects()).toBe(0);
	const cancel = () =>
		h.service.submit(
			h.event({
				actionId: "cancel",
				source: "item",
				targetRef: "item-1",
				sourceRevision: 3,
				input: {},
			}),
		);
	for (let i = 0; i < ACTION_POLICY.cancelReserve; i++) await cancel();
	const reserve = await refused(cancel());
	expect(reserve.code).toBe("action_capacity");
	expect(h.effects()).toBe(ACTION_POLICY.cancelReserve);
	// Rows past their lifetime free capacity automatically.
	h.time.value += 61 * 86_400_000;
	expect((await h.service.submit(h.event())).request.status).toBe("accepted");
});

test("bodies are deleted 30 days after settlement and tombstones 30 days later", async () => {
	fresh();
	const event = h.event();
	await h.service.submit(event);
	h.time.value += 29 * 86_400_000;
	expect(await h.service.maintenance()).toEqual({
		bodies: 0,
		tombstones: 0,
		conflicts: 0,
	});
	h.time.value += 2 * 86_400_000;
	expect((await h.service.maintenance()).bodies).toBe(1);
	const row = h.store.read((db) =>
		db
			.query(
				"SELECT canonical_input_json,result_json,body_deleted_at FROM tool_action_requests",
			)
			.get(),
	) as Record<string, unknown>;
	expect(row.canonical_input_json).toBeNull();
	expect(row.result_json).toBeNull();
	// The tombstone still answers the same eventId without a new execution.
	const again = await h.service.submit(event);
	expect(again.replay).toBe(true);
	expect(again.request.status).toBe("accepted");
	expect(again.request.result?.receiptRef?.operationId).toBe(
		`op-${event.eventId}`,
	);
	expect(h.effects()).toBe(1);
	h.time.value += 31 * 86_400_000;
	expect((await h.service.maintenance()).tombstones).toBe(1);
	expect(h.ledger()).toBe(0);
});

test("registered artifacts, definitions and sources are read through the host, not the client", async () => {
	fresh();
	expect(h.service.artifacts()).toEqual([
		{
			toolchainId: "fake.manage",
			toolchainRevisionId: "toolchain:fake.manage@1",
			artifactRevisionId: ARTIFACT_ID,
			title: "Fake workspace",
			adapterRef: "adapter:fake@1",
			launcher: null,
		},
		{
			toolchainId: null,
			toolchainRevisionId: null,
			artifactRevisionId: HUB_ID,
			title: "Fake hub",
			adapterRef: null,
			launcher: { label: "Hub", group: "manage", order: 1 },
		},
	]);
	const view = h.service.artifact(ARTIFACT_ID);
	expect(view.artifact.id).toBe("fake.workspace");
	expect(view.scopeRef).toBe(h.service.scopeRef);
	expect(h.service.source(ARTIFACT_ID, "setup")).toEqual({
		revision: 0,
		data: { defaults: [0, 0, 90] },
	});
	expect(h.service.source(ARTIFACT_ID, "item", "item-1").revision).toBe(3);
	expect(() => h.service.source(ARTIFACT_ID, "item")).toThrow(
		"target_required",
	);
	expect(() => h.service.source(ARTIFACT_ID, "setup", "item-1")).toThrow(
		"target_not_allowed",
	);
	expect(() => h.service.source(ARTIFACT_ID, "item", "zzz")).toThrow(
		"target_not_found",
	);
	expect(() => h.service.source(ARTIFACT_ID, "nope")).toThrow(
		"source_not_found",
	);
	expect(() => h.service.artifact("artifact:other@1")).toThrow(
		"artifact_not_found",
	);
	h.setAvailable(() => false);
	expect(h.service.artifacts()).toEqual([]);
	expect(() => h.service.artifact(ARTIFACT_ID)).toThrow("adapter_unavailable");
});

test("the accepted and rejected log lines are written only after the transaction committed", async () => {
	fresh();
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: {
			write: (line) => {
				lines.push(line);
			},
		},
	});
	try {
		const seenAtCommit: number[] = [];
		const stop = h.store.onCommit(() => seenAtCommit.push(lines.length));
		await h.service.submit(h.event());
		await h.service.submit(
			h.event({ input: { hours: "0", minutes: "0", seconds: "999" } }),
		);
		stop();
		const events = lines.map((line) => JSON.parse(line).event);
		expect(events).toContain("action_request.accepted");
		expect(events).toContain("action_request.rejected");
		// Each commit was visible before its own line: the first saw none, the second one.
		expect(seenAtCommit).toEqual([0, 1]);
	} finally {
		configureLogging({ level: "silent" });
	}
});

test("a standalone launcher artifact is listed and readable only while every source adapter is available", async () => {
	fresh();
	expect(h.service.artifact(HUB_ID).artifact.id).toBe("fake.hub");
	expect(h.service.source(HUB_ID, "others")).toEqual({
		revision: 1,
		data: { rows: [] },
	});
	expect(h.service.source(HUB_ID, "setup").revision).toBe(0);
	h.setOtherAvailable(false);
	expect(h.service.artifacts().map((a) => a.artifactRevisionId)).toEqual([
		ARTIFACT_ID,
	]);
	expect(() => h.service.artifact(HUB_ID)).toThrow("adapter_unavailable");
	expect(() => h.service.source(HUB_ID, "others")).toThrow(
		"adapter_unavailable",
	);
	// The toolchain artifact does not depend on the other adapter.
	expect(h.service.artifact(ARTIFACT_ID).artifactRevisionId).toBe(ARTIFACT_ID);
	h.setOtherAvailable(true);
	h.setHubActive(false);
	expect(() => h.service.artifact(HUB_ID)).toThrow("artifact_not_found");
	expect(OTHER_REF).toBe("adapter:other@1");
});

test("navigate and draft actions never reach the backend", async () => {
	fresh();
	for (const actionId of ["open", "edit"]) {
		const error = await refused(
			h.service.submit(h.event({ actionId, input: {} })),
		);
		expect([error.code, error.status as number]).toEqual(["local_action", 400]);
	}
	expect(h.ledger()).toBe(0);
	expect(h.invoked).toHaveLength(0);
});

const applyInput = (token: string) => ({
	expectedRevision: 4,
	changes: [{ fieldId: "general.theme", value: "dark" }],
	token,
});

test("a draft-apply write is validated by its schema; confidential keys are redacted and never persisted", async () => {
	fresh();
	const event = h.event({ actionId: "apply", input: applyInput("SECRET-ONE") });
	const { request } = await h.service.submit(event);
	expect(request.status).toBe("accepted");
	// The adapter (the owning domain) receives the real input.
	expect((h.invoked[0]!.input as { token: string }).token).toBe("SECRET-ONE");
	const row = h.store.read((db) =>
		db.query("SELECT * FROM tool_action_requests").get(),
	) as Record<string, unknown>;
	expect(JSON.parse(row.canonical_input_json as string)).toEqual({
		expectedRevision: 4,
		changes: [{ fieldId: "general.theme", value: "dark" }],
		token: "[secret]",
	});
	expect(row.input_digest).toMatch(/^hmac:[0-9a-f]{64}$/);
	// No table of the ledger holds the secret, and the view does not echo it.
	const dump = JSON.stringify(
		h.store.read((db) => [
			db.query("SELECT * FROM tool_action_requests").all(),
			db.query("SELECT * FROM tool_action_request_conflicts").all(),
		]),
	);
	expect(dump).not.toContain("SECRET-ONE");
	expect(JSON.stringify(request)).not.toContain("SECRET-ONE");
	// Schema failures name fields only.
	const invalid = await refused(
		h.service.submit(
			h.event({
				actionId: "apply",
				input: { expectedRevision: "x", changes: [], token: "SECRET-TWO" },
			}),
		),
	);
	expect(invalid.status).toBe(422);
	expect(JSON.stringify(invalid.fieldErrors)).not.toContain("SECRET-TWO");
	expect(h.ledger()).toBe(1);
});

test("confidential replay: same secret returns the stored result, a different secret is a 409", async () => {
	fresh();
	const event = h.event({ actionId: "apply", input: applyInput("SECRET-ONE") });
	const first = await h.service.submit(event);
	h.time.value += 30 * 3_600_000;
	const again = await h.service.submit(event);
	expect(again.replay).toBe(true);
	expect(again.request.result?.receiptRef).toEqual(
		first.request.result?.receiptRef,
	);
	expect(h.effects()).toBe(1);
	const other = await refused(
		h.service.submit({ ...event, input: applyInput("SECRET-TWO") }),
	);
	expect([other.code, other.status as number]).toEqual([
		"request_conflict",
		409,
	]);
	const conflicts = h.store.read((db) =>
		db.query("SELECT input_digest FROM tool_action_request_conflicts").all(),
	) as Array<{ input_digest: string }>;
	expect(conflicts).toHaveLength(1);
	expect(conflicts[0]!.input_digest).toMatch(/^hmac:/);
	expect(JSON.stringify(conflicts)).not.toContain("SECRET");
	expect(h.effects()).toBe(1);
	// Without the host key the stored digest cannot be checked: refuse, do not guess.
	h.setKey(undefined);
	const unavailable = await refused(h.service.submit(event));
	expect([unavailable.code, unavailable.status as number]).toEqual([
		"secret_key_unavailable",
		503,
	]);
});

test("an action that declares confidential fields but carries none needs no host key", async () => {
	fresh();
	h.setKey(undefined);
	for (let i = 0; i < 2; i++) {
		const input = {
			expectedRevision: 4,
			changes: [{ fieldId: "general.theme", value: "dark" }],
		};
		const event = h.event({ actionId: "apply", input });
		const { request } = await h.service.submit(event);
		expect(request.status).toBe("accepted");
		// Digested normally, and replayable without any key.
		const row = h.store.read((db) =>
			db
				.query("SELECT input_digest FROM tool_action_requests WHERE event_id=?")
				.get(event.eventId),
		) as { input_digest: string };
		expect(row.input_digest).toMatch(/^[0-9a-f]{64}$/);
		expect((await h.service.submit(event)).replay).toBe(true);
	}
	expect(h.effects()).toBe(2);
	// A non-empty secret still needs the key.
	const error = await refused(
		h.service.submit(h.event({ actionId: "apply", input: applyInput("S") })),
	);
	expect(error.code).toBe("secret_key_unavailable");
	expect(h.effects()).toBe(2);
});

test("a confidential action without a host key is refused before anything is stored", async () => {
	fresh();
	h.setKey(undefined);
	const error = await refused(
		h.service.submit(h.event({ actionId: "apply", input: applyInput("S") })),
	);
	expect([error.code, error.status as number]).toEqual([
		"secret_key_unavailable",
		503,
	]);
	expect(h.ledger()).toBe(0);
	expect(h.effects()).toBe(0);
	// Ordinary actions do not need the key.
	expect((await h.service.submit(h.event())).request.status).toBe("accepted");
});

test("source params are accepted only for sources with a params schema and are validated", async () => {
	fresh();
	expect(
		h.service.source(ARTIFACT_ID, "records", undefined, {
			offset: 10,
			limit: 5,
			search: "a",
		}).data,
	).toEqual({ rows: [], params: { offset: 10, limit: 5, search: "a" } });
	h.service.source(ARTIFACT_ID, "records");
	expect(h.sourceParams).toEqual([
		{ offset: 10, limit: 5, search: "a" },
		undefined,
	]);
	for (const params of [
		{ offset: -1, limit: 5 },
		{ offset: 0, limit: 5, extra: true },
		"text",
		null,
	]) {
		expect(() =>
			h.service.source(ARTIFACT_ID, "records", undefined, params),
		).toThrow("invalid_params");
	}
	// A source without a registered schema takes no params at all.
	expect(() => h.service.source(ARTIFACT_ID, "setup", undefined, {})).toThrow(
		"invalid_params",
	);
	expect(h.sourceParams).toHaveLength(2);
	expect(h.ledger()).toBe(0);
});

test("conflict audit never stores a plain hash of confidential input", async () => {
	fresh();
	const start = h.event();
	await h.service.submit(start);
	const conflicts = () =>
		h.store.read((db) =>
			db.query("SELECT input_digest FROM tool_action_request_conflicts").all(),
		) as Array<{ input_digest: string }>;
	// Keyed: the event is audited as an HMAC, even for a plain action.
	await refused(
		h.service.submit({
			...start,
			input: { hours: "1", minutes: "0", seconds: "0" },
		}),
	);
	expect(conflicts().map((c) => c.input_digest.startsWith("hmac:"))).toEqual([
		true,
	]);
	h.setKey(undefined);
	// No key, plain action: a plain digest is fine because the action has no secret.
	await refused(
		h.service.submit({
			...start,
			input: { hours: "2", minutes: "0", seconds: "0" },
		}),
	);
	// No key, confidential action: nothing is stored.
	const secret = { ...start, actionId: "apply", input: applyInput("SECRET-X") };
	const error = await refused(h.service.submit(secret));
	expect(error.code).toBe("request_conflict");
	const all = conflicts();
	expect(all).toHaveLength(2);
	expect(all.filter((c) => /^[0-9a-f]{64}$/.test(c.input_digest))).toHaveLength(
		1,
	);
	expect(JSON.stringify(all)).not.toContain("SECRET");
	// An unknown artifact cannot be classified, so nothing is stored either.
	await refused(
		h.service.submit({
			...start,
			artifactRevisionId: "artifact:zz@1",
			input: applyInput("SECRET-Y"),
		}),
	);
	expect(conflicts()).toHaveLength(2);
});
