import { afterEach, expect, test } from "bun:test";
import { bindRequest, ledger, ttl } from "..";
import {
	type Env,
	NOW,
	URL1,
	URL2,
	activateRoute,
	coldAdopt,
	draftOf,
	facts,
	runStep,
	setup,
	source,
	specOf,
	authorScript,
	reviewScript,
	authorJson,
} from "./support";

const envs: Env[] = [];
afterEach(async () => {
	for (const e of envs.splice(0)) await e.close();
});
const mk = async (o?: Parameters<typeof setup>[0]) => {
	const e = await setup(o);
	envs.push(e);
	return e;
};
const keyRow = (env: Env, key: string) =>
	env.store.read((db) => ledger.getKey(db, ledger.getEpoch(db), key)!);

test("D03 observation: valid facts give a private observed proof; warm and unlinked reads give none", async () => {
	const env = await mk();
	const spec = specOf();
	const binding = bindRequest(spec, NOW);
	await env.store.write((db) => {
		const lk = env.routes.lookupInTransaction(db, spec, binding);
		if (lk.kind !== "lookup" || !lk.fence) throw new Error("lookup");
		const base = {
			fence: lk.fence,
			spec,
			binding,
			owner: { rootRunId: "r", taskId: "t" },
			toolId: "web.read" as const,
			sources: [source()],
			facts: facts(),
			lookupProvenance: {
				runId: "r",
				stepId: "s",
				query: spec.keywords,
				searchedAt: NOW,
				provider: "p",
				digest: "a".repeat(64),
				origin: "lookup" as const,
			},
		};
		// URL not offered by the lookup -> valid report but no proof
		const noLink = env.routes.recordObservationInTransaction(db, {
			...base,
			lookupHitUrls: [URL2],
		});
		expect(noLink.kind === "valid" && noLink.proofId).toBe(null);
		// warm -> no proof
		const warm = env.routes.recordObservationInTransaction(db, {
			...base,
			lookupHitUrls: [URL1],
			warm: true,
		});
		expect(warm.kind === "valid" && warm.proofId).toBe(null);
		// candidate import without the original lookup provenance -> no proof
		const cand = env.routes.recordObservationInTransaction(db, {
			...base,
			lookupHitUrls: [URL1],
			lookupProvenance: { ...base.lookupProvenance, origin: "candidate-cache" },
		});
		expect(cand.kind === "valid" && cand.proofId).toBe(null);
		// wrong query -> no proof
		const wrongQ = env.routes.recordObservationInTransaction(db, {
			...base,
			lookupHitUrls: [URL1],
			lookupProvenance: { ...base.lookupProvenance, query: "別の語" },
		});
		expect(wrongQ.kind === "valid" && wrongQ.proofId).toBe(null);
		// wrong child facts are report_invalid, never a proof
		const bad = env.routes.recordObservationInTransaction(db, {
			...base,
			lookupHitUrls: [URL1],
			facts: facts({ maxTemp: 26 }),
		});
		expect(bad.kind).toBe("report_invalid");
		const ok = env.routes.recordObservationInTransaction(db, {
			...base,
			lookupHitUrls: [URL1],
		});
		expect(ok.kind === "valid" && ok.proofId).toBeTruthy();
		const proof = ledger.getProof(db, (ok as { proofId: string }).proofId)!;
		expect(proof.status).toBe("observed");
		expect(proof.facts_json).not.toContain("公開天気ページ"); // no source body / quote kept
		expect(proof.facts_json).not.toContain(facts().evidence[0]!.quote);
	});
});

test("D03 only an adopted proof starts a draft; one open draft per key; the bound proof cannot be swapped", async () => {
	const env = await mk();
	const c = await coldAdopt(env);
	expect(c.adopted.kind).toBe("recorded");
	const d = draftOf(env, c.draftId)!;
	expect(d.state).toBe("queued");
	expect(d.expires_at - d.created_at).toBe(120_000);
	await env.store.write((db) => {
		const proof = ledger.getProof(db, d.proof_id!)!;
		expect(proof.status).toBe("adopted");
		expect(proof.ticket_id).toBe("ticket-1");
		// the same proof cannot be adopted twice
		expect(
			env.routes.recordAdoptedProofAndEnqueueInTransaction(db, {
				proofId: proof.id,
				ticketId: "t2",
				reportEpoch: 2,
			}),
		).toEqual({ kind: "skipped", code: "proof_unavailable" });
		expect(
			env.routes.recordAdoptedProofAndEnqueueInTransaction(db, {
				proofId: "nope",
				ticketId: "t2",
				reportEpoch: 2,
			}),
		).toEqual({ kind: "skipped", code: "proof_unavailable" });
	});
	// a second run's proof for the same key folds into the existing draft: skipped, original proof kept
	await env.store.write((db) => {
		const spec = specOf();
		const lk = env.routes.lookupInTransaction(db, spec, bindRequest(spec, NOW));
		const obs = env.routes.recordObservationInTransaction(db, {
			fence: lk.kind === "lookup" ? lk.fence : null,
			spec,
			binding: bindRequest(spec, NOW),
			owner: { rootRunId: "root-2", taskId: "task-2" },
			toolId: "web.read",
			sources: [source()],
			facts: facts(),
			lookupProvenance: {
				runId: "root-2",
				stepId: "s",
				query: spec.keywords,
				searchedAt: NOW,
				provider: "p",
				digest: "b".repeat(64),
				origin: "lookup",
			},
			lookupHitUrls: [URL1],
		});
		expect(obs.kind === "valid" && obs.proofId).toBeTruthy();
		const r = env.routes.recordAdoptedProofAndEnqueueInTransaction(db, {
			proofId: (obs as { proofId: string }).proofId,
			ticketId: "t3",
			reportEpoch: 1,
		});
		expect(r).toEqual({ kind: "skipped", code: "draft_exists" });
	});
	expect(draftOf(env, c.draftId)!.proof_id).toBe(d.proof_id);
});

test("D03 happy path registers capabilities, version and active pointer in one step; warm lookup is direct", async () => {
	const env = await mk();
	const c = await activateRoute(env);
	expect(draftOf(env, c.draftId)!.state).toBe("activated");
	const k = keyRow(env, c.key);
	expect(k.active_version_id).toBeTruthy();
	await env.store.write((db) => {
		const rev = ledger.getRevision(db, k.active_version_id!)!;
		expect(rev.package_revision_id).toMatch(
			/^package:learned\.web\.[0-9a-f]{32}@1$/,
		);
		expect(rev.context_projection).toContain(URL1);
		expect(
			ledger.getProof(db, ledger.getDraft(db, c.draftId)!.proof_id!)!.status,
		).toBe("consumed");
		const p = env.caps.prepareActiveByIdInTransaction(
			db,
			{ rootRunId: "r", taskId: "t", cancelEpoch: 0 },
			rev.package_revision_id,
			{ url: URL1 },
		);
		expect(p.package.id).toContain("learned.web.");
		const lk = env.routes.lookupInTransaction(db, c.spec, c.binding);
		expect(lk.kind).toBe("direct");
		expect(env.caps.learnedUsageInTransaction(db).count).toBe(2);
	});
});

test("D03 fault after capability registration rolls everything back", async () => {
	const env = await mk({ failPackage: true });
	const c = await coldAdopt(env);
	env.state.scripts.push(authorScript, reviewScript);
	await runStep(env, c.draftId, "author-1");
	await runStep(env, c.draftId, "review-1");
	const d = draftOf(env, c.draftId)!;
	expect(d.state).toBe("rejected");
	expect(d.error_code).toBe("registration_fault_injected");
	expect(keyRow(env, c.key).active_version_id).toBe(null);
	await env.store.write((db) => {
		expect(env.caps.learnedUsageInTransaction(db).count).toBe(0);
		expect(
			db.query("SELECT COUNT(*) n FROM research_route_revisions").get(),
		).toEqual({ n: 0 });
	});
});

test("D03 stale review digest, other epoch/incarnation and wrong fence are refused", async () => {
	const env = await mk();
	const c = await coldAdopt(env);
	env.state.scripts.push(authorScript);
	await runStep(env, c.draftId, "author-1");
	const d = draftOf(env, c.draftId)!;
	expect(d.state).toBe("reviewing");
	const fence = {
		key: c.key,
		epoch: d.epoch,
		incarnation: d.incarnation,
		generation: d.base_generation,
	};
	await env.store.write((db) => {
		expect(
			env.routes.activateInTransaction(db, {
				draftId: d.id,
				fence: { ...fence, incarnation: "other" },
				baseVersionId: null,
				reviewDigest: "0".repeat(64),
			}),
		).toEqual({ kind: "rejected", code: "fence_mismatch" });
	});
	const again = draftOf(env, c.draftId)!;
	expect(again.state).toBe("rejected"); // a refused activation ends the draft; nothing registered
	await env.store.write((db) =>
		expect(env.caps.learnedUsageInTransaction(db).count).toBe(0),
	);
	// stale digest on a fresh draft
	const env2 = await mk();
	const c2 = await coldAdopt(env2);
	env2.state.scripts.push(authorScript);
	await runStep(env2, c2.draftId, "author-1");
	const d2 = draftOf(env2, c2.draftId)!;
	await env2.store.write((db) => {
		const r = env2.routes.activateInTransaction(db, {
			draftId: d2.id,
			fence: {
				key: c2.key,
				epoch: d2.epoch,
				incarnation: d2.incarnation,
				generation: d2.base_generation,
			},
			baseVersionId: null,
			reviewDigest: "f".repeat(64),
		});
		expect(r).toEqual({ kind: "rejected", code: "digest_mismatch" });
	});
	// epoch bump (clear) interrupts at the next step
	const env3 = await mk();
	const c3 = await coldAdopt(env3);
	await env3.store.write((db) => ledger.bumpEpoch(db));
	env3.state.scripts.push(authorScript);
	expect(await runStep(env3, c3.draftId, "author-1")).toEqual({
		stale: "stale_fence",
	});
	expect(draftOf(env3, c3.draftId)!.state).toBe("interrupted");
});

test("D03 disqualified base and fault-time proofs: old-URL proof before the fault is refused, new URL is accepted", async () => {
	const env = await mk();
	const c = await activateRoute(env);
	const k = keyRow(env, c.key);
	env.advance(1000);
	const fence = {
		key: c.key,
		epoch: k.epoch,
		incarnation: k.incarnation,
		generation: k.generation,
	};
	await env.store.write((db) => {
		expect(
			env.routes.recordRouteFailureInTransaction(db, {
				versionId: k.active_version_id!,
				fence,
				failure: "guard_denied",
			}).kind,
		).toBe("ignored");
		expect(
			env.routes.recordRouteFailureInTransaction(db, {
				versionId: k.active_version_id!,
				fence,
				failure: "cancelled",
			}).kind,
		).toBe("ignored");
		expect(
			env.routes.recordRouteFailureInTransaction(db, {
				versionId: k.active_version_id!,
				fence,
				failure: "not_found",
			}).kind,
		).toBe("disqualified");
	});
	env.advance(1000);
	const observe = async (url: string, fetchedAt: string, runId: string) => {
		let proofId: string | null = null;
		await env.store.write((db) => {
			const lk = env.routes.lookupInTransaction(db, c.spec, c.binding);
			expect(lk).toMatchObject({ kind: "lookup", reason: "source_failure" });
			const obs = env.routes.recordObservationInTransaction(db, {
				fence: lk.kind === "lookup" ? lk.fence : null,
				spec: c.spec,
				binding: c.binding,
				owner: { rootRunId: runId, taskId: `${runId}-t` },
				toolId: "web.read",
				sources: [source({ url, fetchedAt })],
				facts: facts(),
				lookupProvenance: {
					runId,
					stepId: "s",
					query: c.spec.keywords,
					searchedAt: env.clock.now(),
					provider: "p",
					digest: "c".repeat(64),
					origin: "lookup",
				},
				lookupHitUrls: [url],
			});
			proofId = obs.kind === "valid" ? obs.proofId : null;
		});
		return proofId as string | null;
	};
	// the stale proof (same URL, fetched before the fault) must not become a new registration
	const stale = await observe(URL1, new Date(NOW).toISOString(), "root-s");
	expect(stale).toBeTruthy();
	await env.store.write((db) => {
		expect(
			env.routes.recordAdoptedProofAndEnqueueInTransaction(db, {
				proofId: stale!,
				ticketId: "ts",
				reportEpoch: 1,
			}),
		).toEqual({ kind: "skipped", code: "stale_proof" });
	});
	// a different URL after the fault is accepted
	const fresh = await observe(
		URL2,
		new Date(env.clock.now()).toISOString(),
		"root-f",
	);
	await env.store.write((db) => {
		expect(
			env.routes.recordAdoptedProofAndEnqueueInTransaction(db, {
				proofId: fresh!,
				ticketId: "tf",
				reportEpoch: 1,
			}),
		).toMatchObject({ kind: "recorded" });
	});
});

test("D03 description edits keep the fetch time and the 30 day limit", async () => {
	const env = await mk();
	const c = await activateRoute(env);
	const k0 = keyRow(env, c.key);
	const v0 = await env.store.read((db) =>
		ledger.getRevision(db, k0.active_version_id!)!,
	);
	env.advance(10 * 24 * 3600_000);
	let r!: ReturnType<typeof env.routes.editInTransaction>;
	const edit = (instruction: string, token?: string) =>
		env.store.write((db) => {
			const k = ledger.getKey(db, ledger.getEpoch(db), c.key)!;
			r = env.routes.editInTransaction(db, {
				key: c.key,
				expectedStateToken:
					token ?? env.routes.getRouteInTransaction(db, c.key)!.stateToken,
				instruction,
			});
			return k;
		});
	await edit("説明をもう少し短くしてください");
	expect(r.kind).toBe("accepted");
	const draftId = (r as { draftId: string }).draftId;
	await edit("もう一度", undefined);
	expect(r).toMatchObject({ kind: "conflict", code: "draft_exists" });
	env.state.scripts.push(authorScript, reviewScript);
	await runStep(env, draftId, "author-1");
	await runStep(env, draftId, "review-1");
	expect(draftOf(env, draftId)!.state).toBe("activated");
	const k1 = keyRow(env, c.key);
	expect(k1.active_version_id).not.toBe(k0.active_version_id);
	expect(k1.last_success_at).toBe(k0.last_success_at);
	const v1 = await env.store.read((db) =>
		ledger.getRevision(db, k1.active_version_id!)!,
	);
	expect(v1.revalidate_at).toBe(v0.revalidate_at);
	expect(v1.revalidate_at - k0.last_success_at!).toBeLessThanOrEqual(
		ttl.absoluteMs,
	);
	expect(v1.revision).toBe(2);
	// structural / stale requests are refused up front
	await edit("取得先URLを https://x.example/ に変更して");
	expect(r).toEqual({
		kind: "rejected",
		code: "recipe_change_requires_rediscovery",
	});
	await edit("説明", "0".repeat(64));
	expect(r).toMatchObject({ kind: "conflict", code: "stale_state_token" });
});

test("D03 an edit whose base was disqualified meanwhile is superseded, and non-active routes are not editable", async () => {
	const env = await mk();
	const c = await activateRoute(env);
	const k = keyRow(env, c.key);
	let draftId = "";
	await env.store.write((db) => {
		const r = env.routes.editInTransaction(db, {
			key: c.key,
			expectedStateToken: env.routes.getRouteInTransaction(db, c.key)!
				.stateToken,
			instruction: "説明を整える",
		});
		draftId = (r as { draftId: string }).draftId;
		env.routes.recordRouteFailureInTransaction(db, {
			versionId: k.active_version_id!,
			fence: {
				key: c.key,
				epoch: k.epoch,
				incarnation: k.incarnation,
				generation: k.generation,
			},
			failure: "format_changed",
		});
		expect(
			env.routes.editInTransaction(db, {
				key: c.key,
				expectedStateToken: env.routes.getRouteInTransaction(db, c.key)!
					.stateToken,
				instruction: "もう一度",
			}),
		).toEqual({ kind: "not_editable" });
	});
	env.state.scripts.push(authorScript);
	expect(await runStep(env, draftId, "author-1")).toEqual({
		stale: "base_changed",
	});
	expect(draftOf(env, draftId)!.state).toBe("superseded");
});

test("D03 author output must keep the host recipe (also exercised via authorJson helper)", () => {
	expect(JSON.parse(authorJson({ a: 1 })).recipe).toEqual({ a: 1 });
});
