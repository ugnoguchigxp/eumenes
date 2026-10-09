import { afterEach, expect, test } from "bun:test";
import { ledger } from "..";
import {
	type Env,
	authorScript,
	coldAdopt,
	draftOf,
	lastMessageJson,
	reviewJson,
	reviewScript,
	runStep,
	setup,
	type Script,
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
const reject =
	(code: string, problems = ["問題あり"]): Script =>
	(m) =>
		reviewJson(lastMessageJson(m).draftDigest, {
			decision: "rejected",
			code,
			problems,
		});
const keyOf = (env: Env, key: string) =>
	env.store.read((db) => ledger.getKey(db, ledger.getEpoch(db), key)!);
const jobKinds = (env: Env) =>
	(
		env.store.read((db) =>
			db
				.query("SELECT dedupe_key k FROM queue_jobs ORDER BY created_seq")
				.all(),
		) as { k: string }[]
	).map((x) => x.k.split(":")[1]);

test("L02 author-1 -> review-1 approved activates in the same settle; 2 inferences only", async () => {
	const env = await mk();
	const c = await coldAdopt(env);
	let seenReview: ReturnType<typeof lastMessageJson> | undefined;
	env.state.scripts.push(authorScript, (m) => {
		seenReview = lastMessageJson(m);
		return reviewScript(m);
	});
	await runStep(env, c.draftId, "author-1");
	await runStep(env, c.draftId, "review-1");
	expect(env.state.calls).toBe(2);
	expect(draftOf(env, c.draftId)!.state).toBe("activated");
	expect(keyOf(env, c.key).active_version_id).toBeTruthy();
	// the reviewer sees the final rendered SKILL and Context, the spec, recipe and host digest
	expect(seenReview!.draft.skill).toContain("取得手順（ホスト固定）");
	expect(seenReview!.draft.context).toContain("完全一致する登録済みの取得先");
	expect(seenReview!.draftDigest).toMatch(/^[0-9a-f]{64}$/);
	expect(jobKinds(env)).toEqual(["author-1", "review-1"]);
});

test("L02 reject -> author-2 -> review-2 (max 4 inferences); a second reject ends the draft", async () => {
	const env = await mk();
	const c = await coldAdopt(env);
	env.state.scripts.push(
		authorScript,
		reject("scope"),
		authorScript,
		reject("policy_conflict"),
	);
	await runStep(env, c.draftId, "author-1");
	await runStep(env, c.draftId, "review-1");
	let d = draftOf(env, c.draftId)!;
	expect(d.state).toBe("queued");
	expect(d.corrections).toBe(1);
	await runStep(env, c.draftId, "author-2");
	// author-2 sees the first review's problems
	await runStep(env, c.draftId, "review-2");
	d = draftOf(env, c.draftId)!;
	expect(d.state).toBe("rejected");
	expect(d.error_code).toBe("policy_conflict");
	expect(env.state.calls).toBe(4);
	expect(jobKinds(env)).toEqual([
		"author-1",
		"review-1",
		"author-2",
		"review-2",
	]);
	expect(keyOf(env, c.key).active_version_id).toBe(null);
	await env.store.write((db) =>
		expect(env.caps.learnedUsageInTransaction(db).count).toBe(0),
	);
});

test("L02 reject then a good second pass activates; author contract failure uses the one correction", async () => {
	const env = await mk();
	const c = await coldAdopt(env);
	env.state.scripts.push(
		authorScript,
		reject("scope"),
		authorScript,
		reviewScript,
	);
	for (const s of ["author-1", "review-1", "author-2", "review-2"] as const)
		await runStep(env, c.draftId, s);
	expect(draftOf(env, c.draftId)!.state).toBe("activated");

	const env2 = await mk();
	const c2 = await coldAdopt(env2);
	env2.state.scripts.push(() => "broken", authorScript, reject("scope"));
	await runStep(env2, c2.draftId, "author-1");
	await runStep(env2, c2.draftId, "author-2");
	expect(draftOf(env2, c2.draftId)!.state).toBe("reviewing");
	await runStep(env2, c2.draftId, "review-2");
	// correction already used by the author failure: no further author round
	const d = draftOf(env2, c2.draftId)!;
	expect(d.state).toBe("rejected");
	expect(env2.state.calls).toBe(3);
});

test("L02 stale/foreign digest, review contract errors and revoked receipts never activate", async () => {
	const env = await mk();
	const c = await coldAdopt(env);
	env.state.scripts.push(
		authorScript,
		() => reviewJson("0".repeat(64)),
		authorScript,
		() => "not json",
	);
	await runStep(env, c.draftId, "author-1");
	await runStep(env, c.draftId, "review-1");
	expect(draftOf(env, c.draftId)!.state).toBe("queued");
	expect(env.state.rejected.some((x) => x.endsWith("review_contract"))).toBe(
		true,
	);
	await runStep(env, c.draftId, "author-2");
	await runStep(env, c.draftId, "review-2");
	expect(draftOf(env, c.draftId)!.state).toBe("rejected");
	expect(keyOf(env, c.key).active_version_id).toBe(null);

	const env2 = await mk();
	const c2 = await coldAdopt(env2);
	env2.state.scripts.push(authorScript, reviewScript);
	await runStep(env2, c2.draftId, "author-1");
	env2.state.accept = false;
	await runStep(env2, c2.draftId, "review-1");
	expect(draftOf(env2, c2.draftId)!.state).toBe("interrupted");
	expect(keyOf(env2, c2.key).active_version_id).toBe(null);
});

test("L02 queue full on the correction hand-off, cancel, expiry and restart-style stale all end draft and job", async () => {
	// queue full at author-2 enqueue
	const env = await mk({ queueLimits: { total: 3, background: 3, scope: 3 } });
	const c = await coldAdopt(env);
	env.state.scripts.push(authorScript, reject("scope"));
	await runStep(env, c.draftId, "author-1");
	// extra open job consumes the last slot so the author-2 enqueue is refused
	await env.store.write((db) => {
		env.queue.enqueueInTransaction(db, {
			scope: "research-routes:owner",
			kind: "research.context-review",
			dedupeKey: "filler",
			payload: { draftId: crypto.randomUUID(), step: "review-1" },
			lane: "background",
		});
	});
	await runStep(env, c.draftId, "review-1");
	const d = draftOf(env, c.draftId)!;
	expect(d.state).toBe("rejected");
	expect(d.error_code).toBe("queue_full");

	// 120s deadline measured from acceptance, including queue wait
	const env2 = await mk();
	const c2 = await coldAdopt(env2);
	env2.state.scripts.push(authorScript);
	await runStep(env2, c2.draftId, "author-1");
	env2.advance(121_000);
	expect(await runStep(env2, c2.draftId, "review-1")).toEqual({
		stale: "draft_deadline",
	});
	expect(draftOf(env2, c2.draftId)!.state).toBe("interrupted");

	// source run revoked after authoring: review is refused with the port's code
	const env3 = await mk();
	const c3 = await coldAdopt(env3);
	env3.state.scripts.push(authorScript);
	await runStep(env3, c3.draftId, "author-1");
	env3.state.allowAdoption = "report_deleted";
	expect(await runStep(env3, c3.draftId, "review-1")).toEqual({
		stale: "report_deleted",
	});
	expect(draftOf(env3, c3.draftId)!.state).toBe("interrupted");
	expect(env3.state.calls).toBe(1);

	// out-of-order steps are stale and change nothing
	const env4 = await mk();
	const c4 = await coldAdopt(env4);
	expect(await runStep(env4, c4.draftId, "review-1")).toEqual({
		stale: "draft_not_reviewing",
	});
	expect(draftOf(env4, c4.draftId)!.state).toBe("queued");
});
