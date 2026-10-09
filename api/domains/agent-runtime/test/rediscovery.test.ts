import { afterEach, expect, test } from "bun:test";
import {
	URL_A,
	coldPackage,
	directBind,
	harness,
	learnedPackage,
	searchBind,
} from "./route-harness";

const open: Awaited<ReturnType<typeof harness>>[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
async function warm(second: "search" | "unmatched" = "search") {
	const h = await harness();
	open.push(h);
	h.proposals.push({
		kind: "direct",
		proposalToken: "pd",
		packageRevisionId: learnedPackage,
	});
	// after the failure the route is disqualified: the port now proposes a normal search
	if (second === "search")
		h.proposals.push({
			kind: "search-first",
			proposalToken: "ps",
			query: "天気予報 鎌倉",
			language: "ja",
			region: "JP",
		});
	else h.proposals.push({ kind: "unmatched" });
	h.binds.set("pd", directBind("tok-old"));
	h.binds.set("ps", searchBind("tok-new"));
	const root = await h.start("run-1");
	await h.runHostStep(root.taskId);
	const child = h.agents.list("run-1").find((t) => t.kind === "worker")!;
	return { h, root, child };
}
const fail = (h: Awaited<ReturnType<typeof harness>>, code: string) =>
	h.results.set("op1", { state: "failed", errorCode: code });

test("A04 site failure on the cached route → old grant revoked, normal package, a REAL lookup, budgets and ordinals kept", async () => {
	const { h, root, child } = await warm();
	fail(h, "web_attempt_timeout");
	const before = h.task(child.id);
	await h.agents.reconcile();
	const c = h.task(child.id);
	expect(c.state).toBe("waiting_tool");
	expect(c.phase).toBe("search");
	expect(c.package_revision_id).toBe(coldPackage);
	expect(c.id).toBe(child.id); // same owner
	expect(c.deadline).toBe(before.deadline);
	expect(c.cancel_epoch).toBe(before.cancel_epoch);
	expect(c.tool_calls).toBe(2); // read + lookup accumulate, never reset
	expect(c.current_step).toBeGreaterThan(before.current_step);
	expect(h.started.map((s) => s.toolId)).toEqual(["web.read", "web.lookup"]);
	expect(h.started[1]!.args).toEqual({
		query: "天気予報 鎌倉",
		language: "ja",
		region: "JP",
	});
	// the root and its answer plan are untouched
	expect(h.task(root.taskId).state).toBe("waiting_child");
	await h.store.read((db) => {
		const b = h.agents.bindingInTransaction(db, child.id)!;
		expect(b.bindingToken).toBe("tok-new");
		expect(b.replacements).toBe(1);
		expect(b.lookupProvenance).toMatchObject({ origin: "lookup" });
		const steps = db
			.query(
				"SELECT ordinal,action_origin,action_kind FROM agent_steps WHERE task_id=? ORDER BY ordinal",
			)
			.all(child.id);
		expect(steps).toEqual([
			{ ordinal: 1, action_origin: "host", action_kind: "replace" },
		]);
	});
	// old binding released in the port; its memory grant is gone after the commit flush
	expect(h.portCalls).toContain("release:tok-old");
	expect(h.ledger.has("tok-old")).toBe(false);
	expect(h.ledger.has("tok-new")).toBe(true);
	// a failing lookup is NOT replaced again (once per child): the model sees it and the budget is shared
	h.results.set("op2", { state: "failed", errorCode: "web_attempt_timeout" });
	await h.agents.reconcile();
	expect(h.task(child.id).state).toBe("queued");
	expect(h.started.length).toBe(2);
});

test("A04 guard / approval / cancel failures never bypass: no lookup is started", async () => {
	for (const code of [
		"web_guard_requires_approval",
		"web_research_unavailable",
	]) {
		const { h, child } = await warm();
		fail(h, code);
		await h.agents.reconcile();
		expect(h.started.length).toBe(1);
		expect(h.portCalls.filter((c) => c === "resolve").length).toBe(1);
		expect(h.task(child.id).state).toBe("queued"); // normal observation → model reports the failure
		await h.close();
		open.pop();
	}
});

test("A04 when no search plan is available the child ends with the original site failure and other roots are untouched", async () => {
	const { h, root, child } = await warm("unmatched");
	// a second, unrelated root
	h.proposals.length = 0;
	h.proposals.push({
		kind: "search-first",
		proposalToken: "ps2",
		query: "q",
		language: "ja",
		region: "JP",
	});
	h.binds.set("ps2", searchBind("tok-other"));
	const other = await h.start("run-2");
	await h.runHostStep(other.taskId);
	const otherChild = h.agents.list("run-2").find((t) => t.kind === "worker")!;
	h.proposals.length = 0;
	h.proposals.push({ kind: "unmatched" });
	fail(h, "web_timeout");
	await h.agents.reconcile();
	expect(h.task(child.id).state).toBe("failed");
	expect(h.task(child.id).error_code).toBe("web_timeout");
	expect(h.task(root.taskId).state).toBe("ready_for_answer");
	// rollback of the failed switch did not touch the other root
	expect(h.task(otherChild.id).state).toBe("waiting_tool");
	expect(h.ledger.has("tok-other")).toBe(true);
	expect(h.started.length).toBe(2); // old read + other root's lookup only
});

test("A04 source_unusable on a cached route supersedes the old observations and switches to a normal search", async () => {
	const { h, child } = await warm();
	h.results.set("op1", h.doc("SENTINEL_TARGET 27"));
	await h.agents.reconcile();
	h.setObservation({ kind: "source_unusable", code: "date_mismatch" });
	await h.runModelStep(child.id, {
		action: "finish",
		report: {
			summary: "s",
			claims: [
				{
					text: "s",
					evidence: [{ sourceId: "x", quote: "SENTINEL_TARGET 27" }],
				},
			],
			limitations: [],
		},
		facts: {},
	});
	const c = h.task(child.id);
	expect(c.state).toBe("waiting_tool");
	expect(c.phase).toBe("search");
	expect(c.package_revision_id).toBe(coldPackage);
	expect(h.started.at(-1)!.toolId).toBe("web.lookup");
	expect(URL_A).toBeDefined();
});
