/**
 * P5-02 (server side of A48): the grounded claim list and the forget list of the
 * owner, view only (claims are kept by the memory steward), over a REAL host store
 * (temp file, WAL, single writer, readonly reader, production migrations, the real
 * conversation SourceAdapter, the real lifecycle). Fixture-grade claims; no
 * model, no network, no browser.
 */
import { expect, test } from "bun:test";
import { createWorldClaims, type WorldClaimsContext } from "..";
import { recordAbandoned } from "../repository/guard";
import {
	NOW,
	PURPOSE,
	SCOPE,
	addMessage,
	adoptPlan,
	claim,
	currentRef,
	entityOp,
	registerClaim,
	request,
} from "./fixture";
import {
	Crash,
	crashHook,
	openLife,
	reopenLife,
	type Life,
} from "./lifecycle-fixture";

const OTHER = "profile:other";
const CTX: WorldClaimsContext = {
	principal: SCOPE.principal,
	scopeKeys: [SCOPE.scopeKey],
};

function build(life: Life, ctx: WorldClaimsContext = CTX) {
	const claims = createWorldClaims({
		store: life.store,
		world: life.world,
		lifecycle: life.lifecycle,
		state: () => ({ mode: "on", gateOpen: life.gate.isOpen() }),
		readPurpose: PURPOSE,
		now: () => NOW,
	});
	const statusOf = (code: string) =>
		code === "world_disabled" ? 409 : code === "world_unavailable" ? 503 : 404;
	const call = async (_method: "GET", url: string) => {
		const { pathname, searchParams } = new URL(url, "http://local");
		const scopeKey = searchParams.get("scopeKey");
		const scope = scopeKey === null ? {} : { scopeKey };
		if (pathname === "/api/world/status")
			return { status: 200, body: claims.status(ctx) as any };
		const detail = /^\/api\/world\/claims\/([^/]+)$/.exec(pathname);
		const result =
			pathname === "/api/world/claims"
				? claims.list(ctx, scope)
				: detail
					? claims.detail(ctx, { ...scope, claimId: detail[1]! })
					: claims.forgets(ctx, scope);
		return result.status === "ok"
			? { status: 200, body: result.value as any }
			: { status: statusOf(result.code), body: { error: result.code } as any };
	};
	return { claims, call };
}

/** m1 (a person's statement), m2 (a later statement used as a reason), claims of each kind. */
async function seed(life: Life) {
	expect((await life.lifecycle.recoverWorld()).status).toBe("open");
	await addMessage(life, "m1", "音声サービスは9月から利用できる。");
	await addMessage(life, "m2", "いいえ、10月からです。");
	await addMessage(life, "a1", "アシスタントの発言", "assistant");
	expect((await life.world.apply(entityOp())).status).toBe("applied");
	const ref1 = currentRef(life, "m1");
	// adopted report of the person
	await life.world.apply(registerClaim("r-1", claim("claim-report", [ref1])));
	await life.world.apply(
		request("a-1", {
			kind: "assertion.transition",
			plan: adoptPlan("claim-report", 1),
		}),
	);
	// a model hypothesis, adopted explicitly (still a hypothesis)
	await life.world.apply(
		registerClaim(
			"r-2",
			claim("claim-hyp", [ref1], {
				origin: "model_hypothesis",
				predicate: "launch_month",
				payload: { kind: "value", value: { kind: "string", value: "9月" } },
			}),
		),
	);
	await life.world.apply(
		request("a-2", {
			kind: "assertion.transition",
			plan: adoptPlan("claim-hyp", 1),
		}),
	);
	// a measured claim, adopted
	const measured = claim("claim-measured", [ref1], {
		origin: "runtime_observation",
		predicate: "latency",
		payload: {
			kind: "value",
			value: { kind: "number", value: 120, unit: "ms" },
		},
	});
	measured.evidence = measured.evidence.map((e) => ({
		...e,
		kind: "runtime_measurement",
	}));
	await life.world.apply(registerClaim("r-3", measured));
	await life.world.apply(
		request("a-3", {
			kind: "assertion.transition",
			plan: adoptPlan("claim-measured", 1),
		}),
	);
	// an unadopted candidate of the person
	await life.world.apply(
		registerClaim(
			"r-4",
			claim("claim-cand", [ref1], {
				predicate: "price",
				payload: { kind: "value", value: { kind: "string", value: "無料" } },
			}),
		),
	);
}

test("the list shows target, claim, adoption, evidence kind and freshness as separate fields; hypothesis and measured are never the adopted style", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const { call } = build(life);
		const listed = await call("GET", "/api/world/claims");
		expect(listed.status).toBe(200);
		expect(listed.body.scopeKey).toBe(SCOPE.scopeKey);
		expect(listed.body.scopes).toEqual([{ scopeKey: SCOPE.scopeKey }]);
		const byId = Object.fromEntries(
			listed.body.items.map((r: any) => [r.id, r]),
		);
		expect(Object.keys(byId).sort()).toEqual([
			"claim-cand",
			"claim-hyp",
			"claim-measured",
			"claim-report",
		]);
		expect(byId["claim-report"]).toMatchObject({
			target: { subjectId: "svc-1" },
			claim: { predicate: "available" },
			adoption: "adopted",
			origin: "user_report",
			evidenceKinds: ["user_statement"],
			// No observation time: current-ness is unknown, never "fresh" by default.
			freshness: "unknown",
			tone: "adopted",
		});
		// Each axis is its own field, not folded into a status string.
		for (const row of listed.body.items)
			expect(Object.keys(row).sort()).toEqual([
				"adoption",
				"claim",
				"evidenceKinds",
				"freshness",
				"id",
				"origin",
				"revision",
				"target",
				"tone",
			]);
		expect(byId["claim-hyp"]).toMatchObject({
			adoption: "adopted",
			origin: "model_hypothesis",
			tone: "hypothesis",
		});
		expect(byId["claim-measured"]).toMatchObject({
			origin: "runtime_observation",
			evidenceKinds: ["runtime_measurement"],
			tone: "measured",
		});
		expect(byId["claim-cand"]).toMatchObject({
			adoption: "candidate",
			tone: "candidate",
		});
		// Only the person's adopted report has the confirmed tone.
		expect(
			listed.body.items
				.filter((r: any) => r.tone === "adopted")
				.map((r: any) => r.id),
		).toEqual(["claim-report"]);
	} finally {
		await life.cleanup();
	}
});

test("the detail carries conditions, supports, refutations, source versions and history", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const { call } = build(life);
		const found = await call("GET", "/api/world/claims/claim-report");
		expect(found.status).toBe(200);
		const d = found.body;
		expect(d.claim.id).toBe("claim-report");
		// No observation was supplied: the condition is unknown, never assumed true.
		expect(d.condition).toMatchObject({
			kind: "unspecified",
			evaluation: "unknown",
		});
		expect(d.supports).toHaveLength(1);
		expect(d.supports[0]).toMatchObject({
			kind: "user_statement",
			stance: "supports",
			source: { namespace: "conversation", kind: "message", id: "m1" },
		});
		expect(d.refutations).toEqual({ evidence: [], claims: [] });
		expect(d.sources).toEqual([
			expect.objectContaining({ id: "m1", state: "current" }),
		]);
		expect(d.history.map((h: any) => [h.revision, h.lifecycle])).toEqual([
			[2, "active"],
			[1, "candidate"],
		]);
		// The source moves on: the claim is stopped and counted, not silently shown.
		await life.conversation.correct({ messageId: "m1", text: "10月から。" });
		const after = await call("GET", "/api/world/claims");
		expect(after.status).toBe(200);
		expect(after.body.items).toEqual([]);
		expect(after.body.stopped).toBe(4);
	} finally {
		await life.cleanup();
	}
});

test("Scope switch: only granted Scopes answer, the others look exactly like not found, and Scopes do not leak into each other", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const both: WorldClaimsContext = {
			principal: SCOPE.principal,
			scopeKeys: [SCOPE.scopeKey, OTHER],
		};
		const { call } = build(life, both);
		// Two granted Scopes: an unqualified read is ambiguous, so it is refused.
		expect((await call("GET", "/api/world/claims")).status).toBe(404);
		const mine = await call(
			"GET",
			`/api/world/claims?scopeKey=${encodeURIComponent(SCOPE.scopeKey)}`,
		);
		expect(mine.status).toBe(200);
		expect(mine.body.items).toHaveLength(4);
		expect(mine.body.scopes.map((s: any) => s.scopeKey).sort()).toEqual(
			[OTHER, SCOPE.scopeKey].sort(),
		);
		// Granted but empty: its own (empty) answer with no count from the other Scope.
		const other = await call(
			"GET",
			`/api/world/claims?scopeKey=${encodeURIComponent(OTHER)}`,
		);
		expect(other.status).toBe(200);
		expect(other.body.items).toEqual([]);
		expect(
			(
				await call(
					"GET",
					`/api/world/claims/claim-report?scopeKey=${encodeURIComponent(OTHER)}`,
				)
			).status,
		).toBe(404);
		// A Scope that was never granted answers like a Scope that does not exist.
		const denied = await call(
			"GET",
			"/api/world/claims?scopeKey=profile:secret",
		);
		const absent = await call("GET", "/api/world/claims?scopeKey=profile:none");
		expect(denied).toEqual(absent);
		expect(denied.status).toBe(404);
	} finally {
		await life.cleanup();
	}
});

test("no existence leak: an unknown claim, a hidden Scope and a forgotten claim give the same answer", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const { call } = build(life);
		const unknown = await call("GET", "/api/world/claims/does-not-exist");
		expect(unknown.status).toBe(404);
		expect(unknown.body).toEqual({ error: "not_found" });
		// Another principal's context sees the same thing for an existing claim.
		const stranger = build(life, {
			principal: "someone-else",
			scopeKeys: [SCOPE.scopeKey],
		});
		const hidden = await stranger.call("GET", "/api/world/claims/claim-report");
		expect(hidden).toEqual(unknown);
		// Even the list of the stranger is not a "forbidden", it is just empty or not found.
		const theirs = await stranger.call("GET", "/api/world/claims");
		expect([200, 404]).toContain(theirs.status);
		if (theirs.status === 200) expect(theirs.body.items).toEqual([]);
		// Neither body names a reason (no "forbidden", no "hidden", no "exists").
		for (const answer of [unknown, hidden])
			expect(JSON.stringify(answer.body)).not.toMatch(
				/forbid|hidden|exist|denied|permit/i,
			);
	} finally {
		await life.cleanup();
	}
});

const accept = (life: Life, forgetId: string) =>
	life.lifecycle.acceptForget({
		forgetId,
		scope: SCOPE,
		reasonCode: "FORGET_REQUESTED",
		roots: [{ kind: "assertion", id: "claim-cand", revision: 1 }],
	});

test("a forget is shown as the ledger says, never as complete before it is; it persists across a restart", async () => {
	let life = await openLife();
	try {
		await seed(life);
		const first = build(life);
		await accept(life, "f-1");
		// The display follows the ledger's own state, never a front-end guess.
		const listed = await first.call("GET", "/api/world/forgets");
		const mine = listed.body.forgets.find((f: any) => f.forgetId === "f-1");
		expect(mine).toBeDefined();
		expect(["pending", "awaiting_confirmation", "complete"]).toContain(
			mine.display,
		);
		expect(mine.display === "complete").toBe(mine.state === "complete");
		expect(mine.abandoned).toEqual({ parts: 0, roots: 0 });
		// The claim is gone from the list (and from the ledger).
		const after = await first.call("GET", "/api/world/claims");
		if (after.status === 200)
			expect(after.body.items.map((r: any) => r.id)).not.toContain(
				"claim-cand",
			);
		// Restart: same database, a new process. The forget is still there.
		life = await reopenLife(life);
		expect((await life.lifecycle.recoverWorld()).status).toBe("open");
		const again = build(life);
		const restarted = (await again.call("GET", "/api/world/forgets")).body
			.forgets;
		expect(restarted.find((f: any) => f.forgetId === "f-1")).toMatchObject({
			forgetId: "f-1",
			state: mine.state,
			display: mine.display,
		});
	} finally {
		await life.cleanup();
	}
});

test("a forget interrupted by a crash is shown as awaiting confirmation (never complete) and finishes after the restart", async () => {
	let life = await openLife({ hook: crashHook("world_applied") });
	try {
		await seed(life);
		const first = build(life);
		// The crash happens while the forget advances: it is accepted, durable and pending.
		await expect(accept(life, "f-crash")).rejects.toBeInstanceOf(Crash);
		const during = (await first.call("GET", "/api/world/forgets")).body.forgets;
		expect(during).toHaveLength(1);
		expect(during[0]).toMatchObject({
			state: "world_applied",
			display: "awaiting_confirmation",
		});
		// The Scope is closed while the forget is unfinished: the list says
		// "not found", the forget list says why.
		expect((await first.call("GET", "/api/world/claims")).status).toBe(404);
		// A new process: the unfinished forget is still unfinished, then resumed.
		life = await reopenLife(life);
		const again = build(life);
		const restarted = (await again.call("GET", "/api/world/forgets")).body
			.forgets;
		expect(restarted[0]).toMatchObject({
			forgetId: during[0].forgetId,
			display: "awaiting_confirmation",
		});
		expect((await life.lifecycle.recoverWorld()).status).toBe("open");
		const done = (await again.call("GET", "/api/world/forgets")).body.forgets;
		expect(done[0]).toMatchObject({ display: "complete", state: "complete" });
		const items = (await again.call("GET", "/api/world/claims")).body.items;
		expect(items.map((r: any) => r.id)).not.toContain("claim-cand");
	} finally {
		await life.cleanup();
	}
});

test("forget that is not finished is shown as pending / awaiting confirmation, and an abandoned part is never complete", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const { call } = build(life);
		// Intake only: nothing was applied yet.
		const queued = await life.lifecycle.acceptForget(
			{
				forgetId: "f-pending",
				scope: SCOPE,
				reasonCode: "FORGET_REQUESTED",
				roots: [{ kind: "assertion", id: "claim-cand", revision: 1 }],
			},
			{ advance: false },
		);
		expect(queued).toMatchObject({ complete: false, state: "pending" });
		let forgets = (await call("GET", "/api/world/forgets")).body.forgets;
		expect(forgets.find((f: any) => f.forgetId === "f-pending")).toMatchObject({
			display: "pending",
			state: "pending",
		});
		// World erased, the external deletion is not confirmed yet.
		await life.store.write((db) =>
			db
				.query(
					"UPDATE world_host_forget_intake SET state = 'world_applied' WHERE forget_id = 'f-pending'",
				)
				.run(),
		);
		forgets = (await call("GET", "/api/world/forgets")).body.forgets;
		expect(forgets.find((f: any) => f.forgetId === "f-pending")).toMatchObject({
			display: "awaiting_confirmation",
			state: "world_applied",
		});
		// A forget that World refused part of is abandoned even when its state says complete.
		await life.store.write((db) => {
			db.query(
				"UPDATE world_host_forget_intake SET state = 'complete' WHERE forget_id = 'f-pending'",
			).run();
			recordAbandoned(
				db,
				{
					forgetId: "f-pending",
					part: 0,
					skippedRoots: 1,
					wholePart: true,
					reason: "INVALID_INPUT",
				},
				NOW,
			);
		});
		forgets = (await call("GET", "/api/world/forgets")).body.forgets;
		const abandoned = forgets.find((f: any) => f.forgetId === "f-pending");
		expect(abandoned.display).toBe("abandoned");
		expect(abandoned.abandoned.parts).toBe(1);
		expect(abandoned.display).not.toBe("complete");
		// Another Scope's forgets are never listed.
		await life.lifecycle.acceptForget(
			{
				forgetId: "f-other",
				scope: { principal: SCOPE.principal, scopeKey: OTHER },
				reasonCode: "FORGET_REQUESTED",
				roots: [{ kind: "assertion", id: "x", revision: 1 }],
			},
			{ advance: false },
		);
		forgets = (await call("GET", "/api/world/forgets")).body.forgets;
		expect(forgets.map((f: any) => f.forgetId)).toEqual(["f-pending"]);
	} finally {
		await life.cleanup();
	}
});

test("World OFF (protect): reads answer world_disabled; the forget list still tells the truth", async () => {
	const life = await openLife();
	try {
		await seed(life);
		await life.world.setEnabled(false);
		const { call } = build(life);
		for (const answer of [
			await call("GET", "/api/world/claims"),
			await call("GET", "/api/world/claims/claim-report"),
		]) {
			expect(answer.status).toBe(409);
			expect(answer.body).toEqual({ error: "world_disabled" });
		}
		const status = await call("GET", "/api/world/status");
		expect(status.body).toMatchObject({ enabled: false, usable: false });
		expect((await call("GET", "/api/world/forgets")).status).toBe(200);
	} finally {
		await life.cleanup();
	}
});
