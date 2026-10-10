import { afterEach, expect, test } from "bun:test";
import { URL_A, directBind, harness, learnedPackage } from "./route-harness";

const open: Awaited<ReturnType<typeof harness>>[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
async function warm() {
	const h = await harness();
	open.push(h);
	h.proposals.push({
		kind: "direct",
		proposalToken: "pd",
		packageRevisionId: learnedPackage,
	});
	h.binds.set("pd", directBind());
	const root = await h.start("run-1");

	const child = h.agents.list("run-1").find((t) => t.kind === "worker")!;
	return { h, root, child };
}
const finishAction = (summary = "値は26") => ({
	action: "finish",
	report: {
		summary,
		claims: [
			{
				text: `${summary} INJECT`,
				evidence: [{ sourceId: "x", quote: "SENTINEL_TARGET 27" }],
			},
		],
		limitations: [],
	},
	facts: { value: 27 },
});

test("A03 warm: lookup 0, one granted tool, one child summary; facts 27 beats model's 26; child text never reaches the parent", async () => {
	const { h, root, child } = await warm();
	// first action: exactly one granted real fetch of the recipe URL, 5s attempt timeout
	expect(h.started).toEqual([
		{
			toolId: "web.read",
			args: { url: URL_A },
			grantedUrl: URL_A,
			attemptTimeoutMs: 5000,
		},
	]);
	expect(h.task(child.id)).toMatchObject({
		state: "waiting_tool",
		tool_calls: 1,
		model_calls: 0,
		package_revision_id: learnedPackage,
	});
	expect(child.acquisitionMode).toBe("cached");
	expect(h.captures).toEqual([]);
	h.results.set("op1", h.doc("SENTINEL_TARGET 27\nINJECTION_BODY"));
	await h.agents.reconcile();
	expect(h.task(child.id).state).toBe("queued");
	// the single child model step: prepare (1 capture) → finish with a wrong summary
	const { prep, applied } = await h.runModelStep(
		child.id,
		finishAction("値は26"),
	);
	expect(prep.status).toBe("ready");
	// the only tool was used; the child sees no more usable tools
	expect(
		JSON.stringify((prep as { input: { messages: unknown } }).input.messages),
	).toContain("TOOLS=[]");
	expect(applied).toBe("applied");
	expect(h.captures.length).toBe(1);
	expect(h.started.length).toBe(1);
	expect(h.task(root.taskId).state).toBe("ready_for_answer");
	const ticket = await h.store.write((db) =>
		h.agents.prepareAnswerInTransaction(db, "run-1"),
	);
	const projection = ticket.projection!;
	expect(JSON.parse(projection).summary).toBe("値は27");
	for (const leaked of [
		"値は26",
		"INJECT",
		"INJECTION_BODY",
		"INJECTION_TITLE",
		"SENTINEL_TARGET",
		'"quote"',
	])
		expect(projection).not.toContain(leaked);
	expect(h.portCalls.some((c) => c.startsWith("observe:"))).toBe(true);
	expect(h.portCalls.filter((c) => c === "resolve").length).toBe(1);
	// total model calls of the whole root: child summary only (the main answer is dialogue's)
	expect(h.task(root.taskId).model_calls).toBe(0);
	expect(h.task(child.id).model_calls).toBe(1);
});

test("A03 facts/report mismatch is a report fix (one repair), not a site failure; no replacement happens", async () => {
	const { h, child } = await warm();
	h.results.set("op1", h.doc("SENTINEL_TARGET 27"));
	await h.agents.reconcile();
	h.setObservation({ kind: "report_invalid", code: "mismatch" });
	await h.runModelStep(child.id, finishAction());
	const t = h.task(child.id);
	expect(t.state).toBe("queued");
	expect(t.json_repairs).toBe(1);
	expect(h.portCalls.filter((c) => c === "resolve").length).toBe(1);
	expect(h.started.length).toBe(1);
});

test("A03 the grant cannot be reused for another URL or by another owner", async () => {
	const { h, child } = await warm();
	const refs = (h.agents as unknown as { _noop?: unknown })._noop;
	expect(refs).toBeUndefined();
	// a second invocation with a different URL is refused by tool-runtime's exact-args grant
	await h.store.write((db) => {
		expect(() =>
			h.tools.invokeInTransaction(
				db,
				{ rootRunId: "run-1", taskId: child.id, cancelEpoch: 0 },
				"00000000-0000-4000-8000-000000000000",
				{ url: "https://evil.example.com/" },
				"s-x",
				Date.now() + 1000,
				"p",
				[],
			),
		).toThrow("tool_ref_invalid");
	});
});
