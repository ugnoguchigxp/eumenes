import { expect, test } from "bun:test";
import { check, fixture, plan, proposal, verify } from "./fixture";
import type { SupervisionChildEvidence } from "../contracts";

test("a follow-up verification cannot accept a reading that changed while the judge was working", async () => {
	let changeRead = () => {};
	const f = await fixture((data) => {
		if ("amendments" in data) return { mode: "verify" };
		if ("researchRemaining" in data)
			return plan([
				proposal("read", "Read then verify", { verification: verify }),
			]);
		if (
			(data.child as { evidence: SupervisionChildEvidence[] }).evidence[0]
				?.kind === "read"
		)
			return {
				action: "verify",
				reason: "Verify the reading.",
				refs: ["reading"],
			};
		changeRead();
		return { action: "accept", reason: "Check passed.", refs: ["check"] };
	});
	try {
		await f.waitFor(() => f.children.size === 1);
		const [reader] = [...f.children.values()];
		f.complete(reader!, [
			{
				ref: "reading",
				kind: "read",
				path: "input.ts",
				executionId: reader!.executionId!,
				targetRevision: "base",
				inputDigest: "input-before",
				text: "Read the input.",
			},
		]);
		await f.waitFor(() => f.children.size === 2);
		await f.restart();
		const verifier = [...f.children.values()][1]!;
		changeRead = () => f.readInputChanged("changed-input");
		f.complete(verifier, [
			{
				ref: "check",
				kind: "check",
				check,
				passed: true,
				executionId: verifier.executionId!,
				targetRevision: "base",
				inputDigest: "input-before",
				text: "Passed.",
			},
		]);
		await f.waitFor(() => f.view().result !== null);
		expect(f.view().status).toBe("partial");
		expect(f.progress().tasks[0]?.reason).toContain("静的読解");
	} finally {
		await f.close();
	}
});

for (const [name, order, expected] of [
	["later failure", ["edit", "pass", "fail"], "partial"],
	["check before final edit", ["pass", "edit"], "partial"],
	["fresh verification after failure", ["edit", "fail", "pass"], "completed"],
] as const) {
	test(`adoption uses the current check after the last edit: ${name}`, async () => {
		const f = await fixture((data) =>
			"amendments" in data
				? { mode: "edit" }
				: "researchRemaining" in data
					? plan([proposal("edit")])
					: {
							action: "accept",
							reason: "The cited check passed.",
							refs: ["edit", "pass"],
						},
		);
		try {
			await f.waitFor(() => f.children.size === 1);
			const child = [...f.children.values()][0]!;
			f.workspaceChanged("final-input");
			// A reverted intermediate change can produce the same digest more than once.
			const evidence = order.map((ref): SupervisionChildEvidence => ({
				ref,
				executionId: child.executionId!,
				targetRevision: "base",
				inputDigest: "final-input",
				text: ref,
				...(ref === "edit"
					? { kind: "edit", path: "code.ts" }
					: { kind: "check", check, passed: ref === "pass" }),
			}));
			f.complete(child, evidence);
			await f.waitFor(() => f.view().result !== null);
			expect(f.view().status).toBe(expected);
			if (expected === "partial") {
				expect(f.view().result!.refs).not.toContain("pass");
				if (name === "later failure")
					expect(f.view().result!.refs).toContain("fail");
			}
		} finally {
			await f.close();
		}
	});
}

test("the supervisor can accept and retain the final edit and all twelve approved checks", async () => {
	const checks = Array.from({ length: 12 }, (_, i) => ({
		...check,
		args: ["test", `case-${i}.ts`],
	}));
	const refs = ["edit", ...checks.map((_, i) => `check-${i}`)];
	const f = await fixture((data) =>
		"amendments" in data
			? { mode: "edit" }
			: "researchRemaining" in data
				? plan([proposal("edit", "All fixtures", { checks })])
				: {
						action: "accept",
						reason: "All approved checks passed after the edit.",
						refs,
					},
	);
	try {
		await f.waitFor(() => f.children.size === 1);
		const child = [...f.children.values()][0]!;
		f.workspaceChanged("final-input");
		const observed = {
			executionId: child.executionId!,
			targetRevision: "base",
			inputDigest: "final-input",
			text: "observed",
		};
		f.complete(child, [
			{ ...observed, kind: "edit", ref: "edit", path: "code.ts" },
			...checks.map((current, i) => ({
				...observed,
				kind: "check" as const,
				ref: `check-${i}`,
				check: current,
				passed: true,
			})),
		]);
		await f.waitFor(() => f.view().result !== null);
		expect(f.view().status).toBe("completed");
		expect(f.progress().tasks[0]?.result?.refs).toEqual(refs);
		expect(f.view().result?.refs).toEqual(refs);
	} finally {
		await f.close();
	}
});

for (const change of [
	"delivery revision",
	"proof outcome",
	"child result",
] as const) {
	test(`judge adoption distinguishes a ${change} change`, async () => {
		let duringJudgement = () => {};
		const f = await fixture((data) => {
			if ("amendments" in data) return { mode: "verify" };
			if ("researchRemaining" in data) return plan([proposal("verify")]);
			if (!data.child) throw new Error("unexpected control");
			duringJudgement();
			return {
				action: "accept",
				reason: "The check passed.",
				refs: ["verification"],
			};
		});
		try {
			await f.waitFor(() => f.children.size === 1);
			const child = [...f.children.values()][0]!;
			duringJudgement = () => {
				child.view.revision++;
				if (change === "proof outcome") child.evidence[0]!.passed = false;
				if (change === "child result")
					child.view.result!.summary = "A materially different outcome.";
			};
			f.complete(child, [
				{
					ref: "verification",
					executionId: child.executionId!,
					targetRevision: "base",
					inputDigest: "input-before",
					kind: "check",
					text: "The live verification passed.",
					passed: true,
					check,
				},
			]);
			await f.waitFor(() => f.view().result !== null);
			expect(f.view().status).toBe(
				change === "delivery revision" ? "completed" : "partial",
			);
			const task = f.progress().tasks[0]!;
			expect(task.reason).toBe(
				change === "delivery revision"
					? "The check passed."
					: "受入判断時の子仕事、対象版または証跡が更新されました。",
			);
		} finally {
			await f.close();
		}
	});
}
