import { expect, test } from "bun:test";
import { hash } from "../../capabilities";
import { check, fixture, plan, proposal, verify } from "./fixture";

const isAuthority = (data: Record<string, unknown>) => "amendments" in data;
const isPlan = (data: Record<string, unknown>) => "researchRemaining" in data;

function isChild(data: Record<string, unknown>) {
	return !!data.child;
}

test("each accepted amendment advances its task revision while the previous amendment is still pending", async () => {
	const f = await fixture((data) =>
		isAuthority(data) ? { mode: "read" } : plan([proposal("read")]),
	);
	try {
		await f.waitFor(() => f.children.size === 1);
		const [row] = f.board();
		await f.withWriter((db, owner) => {
			const amend = (revision: number, request: string) =>
				owner.controlFromBoardInTransaction(db, {
					conversationId: row!.conversationId,
					parentId: row!.parentId,
					taskId: row!.taskId,
					expectedRevision: revision,
					request,
					action: "amend",
					operationId: crypto.randomUUID(),
				});
			const first = amend(row!.revision, "Review the first input.");
			const second = amend(first.tasks[0]!.revision, "Review both inputs.");
			expect(second.tasks[0]!.revision).toBeGreaterThan(
				first.tasks[0]!.revision,
			);
			expect(second.revision).toBeGreaterThan(first.revision);
			expect(() =>
				db.transaction(() =>
					amend(first.tasks[0]!.revision, "Earlier draft."),
				)(),
			).toThrow("execution_revision_conflict");
		});
	} finally {
		await f.close();
	}
});

test("a full conversation queue preserves the finished parent and retries its notice once after restart", async () => {
	const f = await fixture((data) =>
		isAuthority(data) ? { mode: "design" } : plan([], "review"),
	);
	try {
		let attempted: string | undefined;
		f.onNotice((db, id) => {
			attempted = id;
			// Dialogue appends its message before enqueueing the run.
			db.run("CREATE TABLE IF NOT EXISTS notice_attempt(id TEXT PRIMARY KEY)");
			db.query("INSERT INTO notice_attempt VALUES (?)").run(id);
			throw new Error("queue_full");
		});
		await f.waitFor(() => !!attempted);
		expect(f.view().status).toBe("completed");
		expect(f.notices.size).toBe(0);
		f.onNotice((db, id) => {
			expect(id).toBe(attempted!);
			expect(
				db
					.query("SELECT name FROM sqlite_master WHERE name='notice_attempt'")
					.get(),
			).toBeNull();
		});
		await f.restart();
		await f.waitFor(() => f.notices.size > 0);
		expect([...f.notices.keys()]).toEqual([attempted!]);
	} finally {
		await f.close();
	}
});

test("a released child loses execution authority while its sibling remains active", async () => {
	const f = await fixture((data) =>
		isAuthority(data)
			? { mode: "verify" }
			: isPlan(data)
				? plan([proposal("verify"), proposal("read")])
				: { action: "accept", reason: "Verified.", refs: ["passed"] },
	);
	try {
		await f.waitFor(() => f.children.size === 2);
		const [first, sibling] = [...f.children.values()];
		f.complete(first!, [
			{
				ref: "passed",
				executionId: first!.executionId!,
				kind: "check",
				check,
				passed: true,
				text: "Passed",
				targetRevision: "base",
				inputDigest: "input-before",
			},
		]);
		await f.waitFor(() => f.board().some((row) => row.state === "finished"));
		expect(f.view().result).toBeNull();
		expect(f.grant(first!, "view")).not.toBeNull();
		expect(f.grant(first!, "continue")).toBeNull();
		expect(f.grant(first!, "start")).not.toBeNull();
		expect(f.grant(first!, "start", { workId: undefined })).toBeNull();
		expect(f.grant(sibling!, "continue")).not.toBeNull();
	} finally {
		await f.close();
	}
});

test("a queued child keeps its own slot and reports an explicit isolation hold on both views", async () => {
	const f = await fixture((data) =>
		isAuthority(data) ? { mode: "verify" } : plan([proposal("verify")]),
	);
	try {
		await f.waitFor(() => f.progress().tasks[0]?.state === "running");
		const child = [...f.children.values()][0]!;
		child.view.status = "queued";
		child.view.revision++;
		await f.waitFor(() => f.progress().tasks[0]?.state === "waiting");
		expect(f.progress().tasks[0]?.reason).toBe("子仕事の開始待ち");
		const reason = "検証用の書込み制限を適用できないため保留しています。";
		child.view.progress = { summary: reason, observedAt: f.now() };
		child.blocking = { state: "held", reason };
		child.releaseConfirmed = true;
		child.view.revision++;
		await f.waitFor(() => f.progress().tasks[0]?.state === "held");
		expect(f.progress().tasks[0]?.reason).toBe(reason);
		expect(f.board()).toEqual(f.progress().tasks);
		expect(f.children.size).toBe(1);
	} finally {
		await f.close();
	}
});

test("the registered design-only work persists the same design without delegating an edit", async () => {
	const f = await fixture(
		(data) => (isAuthority(data) ? { mode: "design" } : plan([], "review")),
		"Prepare a design for review.",
	);
	try {
		await f.waitFor(
			() => f.view().status === "completed" && f.notices.size === 1,
		);
		const design = [...f.designs.values()][0]!;
		expect(f.children.size).toBe(0);
		expect(f.progress().designs[0]?.digest).toBe(hash(design.markdown));
		expect(f.view().result?.links).toEqual([design.uri]);
		await f.restart();
		await f.waitFor(() => f.view().status === "completed");
		expect(f.notices.size).toBe(1);
	} finally {
		await f.close();
	}
});

test("a review-only ceiling prevents an otherwise valid-shaped edit proposal", async () => {
	const f = await fixture(
		(data) =>
			isAuthority(data) ? { mode: "design" } : plan([proposal("edit")]),
		"Please review how to fix the source and run the regression check later.",
	);
	try {
		await f.waitFor(() => f.progress().reason.includes("範囲"));
		expect(f.children.size).toBe(0);
		expect(f.designs.size).toBe(0);
	} finally {
		await f.close();
	}
});

for (const fault of [
	"old-input",
	"other-execution",
	"user-diff-changed",
	"none",
] as const) {
	test(`edit acceptance requires a real current edit, post-edit check and preserved user diff (${fault})`, async () => {
		const f = await fixture((data) =>
			isAuthority(data)
				? { mode: "edit" }
				: isPlan(data)
					? plan([proposal("edit")])
					: {
							action: "accept",
							reason: "The approved patch passes.",
							refs: ["source-edit", "test-pass"],
						},
		);
		try {
			await f.waitFor(() => f.children.size === 1);
			const child = [...f.children.values()][0]!;
			const workId = child.view.id;
			expect(f.grant(child, "continue")?.scope.baselineInputDigest).toBe(
				"input-before",
			);
			expect(
				f.grant(child, "continue", { request: "change another task" }),
			).toBeNull();
			expect(
				f.grant(child, "continue", { workId: crypto.randomUUID() }),
			).toBeNull();
			expect(
				f.grant(child, "continue", {
					source: {
						...child.start.source,
						delegation: { ...child.start.source.delegation, taskGeneration: 1 },
					},
				}),
			).toBeNull();
			expect(
				f.grant(child, "continue", { bindingRevisionId: "binding:other@1" }),
			).toBeNull();
			f.workspaceChanged("input-after", fault !== "user-diff-changed");
			f.complete(child, [
				{
					ref: "source-edit",
					text: "Fixed the source",
					executionId: child.executionId!,
					kind: "edit",
					targetRevision: "base",
					inputDigest: "input-after",
					path: "code.ts",
				},
				{
					ref: "test-pass",
					text: "Regression passed",
					executionId:
						fault === "other-execution"
							? crypto.randomUUID()
							: child.executionId!,
					kind: "check",
					targetRevision: "base",
					inputDigest: fault === "old-input" ? "input-before" : "input-after",
					passed: true,
					check,
				},
			]);
			await f.waitFor(
				() =>
					f.view().result !== null &&
					[...f.notices.values()].filter(({ result }) => result !== null)
						.length === 1,
			);
			expect(f.grant(child, "continue", { workId })).toBeNull();
			expect(f.view().status).toBe(fault === "none" ? "completed" : "partial");
			expect(f.board()).toEqual(f.progress().tasks);
		} finally {
			await f.close();
		}
	});
}

test("two questions use FIFO presentation windows and keep their destinations across recovery", async () => {
	const f = await fixture((data) =>
		isAuthority(data)
			? { mode: "verify" }
			: plan([proposal("verify"), proposal("read")]),
	);
	try {
		await f.waitFor(() => f.children.size === 2);
		const [active, reader] = [...f.children.values()];
		const firstId = await f.question(reader!, "Read question");
		const secondId = await f.question(active!, "SDK question", true);
		await f.waitFor(() => f.view().question !== null);
		expect(f.view().question?.prompt).toBe("Read question");
		const first = f.view().question!;
		const issuedAt = first.expiresAt - 15 * 60_000;
		await f.restart();
		expect(f.view().question).toEqual(first);
		f.advance(14 * 60_000);
		await f.control(
			"answer",
			{ questionRef: first.id },
			"Use the first value.",
		);
		expect(f.answers).toEqual([
			{
				workId: reader!.view.id,
				questionId: firstId,
				answer: "Use the first value.",
			},
		]);
		await f.waitFor(() => f.view().question?.prompt === "SDK question");
		const second = f.view().question!;
		expect(second.expiresAt).toBe(issuedAt + 29 * 60_000);
		f.advance(6 * 60_000);
		await expect(
			f.control("answer", { questionRef: first.id }, "Old answer"),
		).rejects.toThrow("invalid_answer");
		await f.control(
			"answer",
			{ questionRef: second.id },
			"Use the second value.",
		);
		expect(f.answers).toEqual([
			{
				workId: reader!.view.id,
				questionId: firstId,
				answer: "Use the first value.",
			},
			{
				workId: active!.view.id,
				questionId: secondId,
				answer: "Use the second value.",
			},
		]);
	} finally {
		await f.close();
	}
});

test("read release precedes a new verification child and a busy edit slot does not consume a read slot", async () => {
	const f = await fixture((data) => {
		if (isAuthority(data)) return { mode: "verify" };
		if (isPlan(data))
			return plan([
				proposal("verify", "First check"),
				proposal("read", "Read then check", { verification: verify }),
			]);
		if (isChild(data)) {
			const child = data.child as { evidence: { ref: string }[] };
			const ref = child.evidence[0]?.ref;
			return {
				action: ref === "read-proof" ? "verify" : "accept",
				reason: "Evidence confirmed",
				refs: [ref],
			};
		}
		throw new Error("unexpected model call");
	});
	try {
		await f.waitFor(() => f.children.size === 2);
		const [active, reader] = [...f.children.values()];
		const read = {
			ref: "read-proof",
			text: "Read the source",
			executionId: reader!.executionId!,
			kind: "read" as const,
			targetRevision: "base",
			inputDigest: "input-before",
			path: "input.ts",
		};
		f.complete(reader!, [read]);
		reader!.releaseConfirmed = false;
		await f.waitFor(
			() => f.progress().tasks[1]?.reason.includes("解放") === true,
		);
		expect(f.children.size).toBe(2);
		reader!.releaseConfirmed = true;
		await f.waitFor(() => f.progress().tasks[1]?.reason === "編集枠待ち");
		const originalTask = f.progress().tasks[1]!.taskId;
		expect(f.progress().tasks[1]?.evidenceRefs).toContain(read.ref);
		await f.restart();
		expect(f.progress().tasks[1]?.evidenceRefs).toContain(read.ref);
		f.complete(active!, [
			{
				ref: "first-test",
				text: "Passed",
				executionId: active!.executionId!,
				kind: "check",
				targetRevision: "base",
				inputDigest: "input-before",
				passed: true,
				check,
			},
		]);
		await f.waitFor(() => f.children.size === 3);
		const successor = [...f.children.values()][2]!;
		expect(successor.view.id).not.toBe(reader!.view.id);
		expect(successor.start.source.delegation.taskId).toBe(originalTask);
		f.complete(successor, [
			{
				ref: "new-test",
				text: "Passed",
				executionId: successor.executionId!,
				kind: "check",
				targetRevision: "base",
				inputDigest: "input-before",
				passed: true,
				check,
			},
		]);
		await f.waitFor(() => f.view().status === "completed");
		expect(f.children.size).toBe(3);
		expect(f.board()).toEqual(f.progress().tasks);
	} finally {
		await f.close();
	}
});

test("cancelling the parent revokes answers and continuations before old work finally releases", async () => {
	const f = await fixture((data) =>
		isAuthority(data)
			? { mode: "verify" }
			: plan([proposal("verify"), proposal("verify", "Waiting sibling")]),
	);
	try {
		await f.waitFor(() => f.children.size === 1);
		const child = [...f.children.values()][0]!;
		await f.question(child, "May I continue?");
		await f.waitFor(() => f.view().question !== null);
		const question = f.view().question!;
		await f.control("cancel", {}, "Cancel the development work.");
		expect(f.view().status).toBe("stopping");
		expect(child.stopped).toBe(true);
		expect(f.view().question).toBeNull();
		expect(f.grant(child, "continue")).toBeNull();
		expect(f.grant(child, "view")).not.toBeNull();
		await f.restart();
		await f.waitFor(() => f.view().status === "stopping");
		expect(f.children.size).toBe(1);
		await expect(
			f.control("answer", { questionRef: question.id }, "Continue."),
		).rejects.toThrow("execution_terminal");
		f.complete(child, [
			{
				ref: "late-success",
				text: "A late pass",
				kind: "check",
				executionId: child.executionId!,
				targetRevision: "base",
				inputDigest: "input-before",
				check,
				passed: true,
			},
		]);
		await f.waitFor(() => f.view().status === "cancelled");
		expect(f.view().result?.refs).toEqual([]);
		expect(f.children.size).toBe(1);
		expect(
			[...f.notices.values()].filter(({ status }) => status === "cancelled"),
		).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("a stop-unconfirmed child keeps another task held across a backend restart", async () => {
	const f = await fixture((data) => {
		if (isAuthority(data)) return { mode: "verify" };
		if (isPlan(data))
			return plan([
				proposal("read", "Reader"),
				proposal("verify", "First check"),
				proposal("verify", "Next check"),
			]);
		const child = data.child as { evidence: { ref: string }[] };
		return child.evidence.length
			? {
					action: "accept",
					reason: "Check passed.",
					refs: [child.evidence[0]!.ref],
				}
			: {
					action: "finish",
					reason: "The observation was lost.",
					status: "interrupted",
				};
	});
	try {
		await f.waitFor(() => f.children.size === 2);
		const [reader, check1] = [...f.children.values()].sort(
			(a, b) =>
				Number(b.start.request.includes("Read the target.")) -
				Number(a.start.request.includes("Read the target.")),
		);
		reader!.view.stop = "unconfirmed";
		reader!.view.status = "stopping";
		await f.waitFor(
			() => f.progress().tasks[2]?.reason === "他タスクの停止未確認",
		);
		f.complete(check1!, [
			{
				ref: "first-passed",
				kind: "check",
				executionId: check1!.executionId!,
				text: "Passed",
				targetRevision: "base",
				inputDigest: "input-before",
				passed: true,
				check,
			},
		]);
		await f.restart();
		await f.waitFor(() => f.progress().tasks[1]?.state === "finished");
		expect(f.children.size).toBe(2);
		expect(f.board()[2]).toMatchObject({
			state: "held",
			reason: "他タスクの停止未確認",
			blockerRef: reader!.view.id,
		});
		f.complete(reader!, [], "interrupted");
		await f.waitFor(() => f.children.size === 3);
		const next = [...f.children.values()][2]!;
		f.complete(next, [
			{
				ref: "next-passed",
				kind: "check",
				executionId: next.executionId!,
				text: "Passed",
				targetRevision: "base",
				inputDigest: "input-before",
				passed: true,
				check,
			},
		]);
		await f.waitFor(() => f.view().status === "partial");
		expect(f.progress().designs[0]?.uri).toBeTruthy();
		expect(f.view().result?.links).toEqual([f.progress().designs[0]!.uri!]);
		expect(f.children.size).toBe(3);
	} finally {
		await f.close();
	}
});

test("a partial source result contributes its scoped evidence to a persisted design", async () => {
	const f = await fixture(
		(data) => {
			if (isAuthority(data)) return { mode: "design" };
			const research = data.research as { note: { text: string } | null }[];
			if (!research.length)
				return {
					action: "research",
					questions: [
						{
							kind: "inspect.source",
							request: "Find the empty-row filter in input.ts.",
						},
					],
				};
			expect(research[0]?.note?.text).toContain("input.ts");
			return plan([], "review");
		},
		"Investigate input.ts and prepare a design for review.",
		true,
	);
	try {
		await f.waitFor(() => f.view().status === "completed");
		expect(f.research.size).toBe(1);
		expect(f.children.size).toBe(0);
		expect(f.progress().designs[0]?.uri).toBeTruthy();
	} finally {
		await f.close();
	}
});

test("an approved request supplies authority to its acceptance utterance and remains revocable", async () => {
	const confirmedRequest =
		"Please fix the source and run the regression check.";
	const f = await fixture(
		(data) => {
			if (isAuthority(data)) {
				expect(data.request).toBe("Proceed.");
				expect(data.confirmedRequest).toBe(confirmedRequest);
				return { mode: "edit" };
			}
			return plan([proposal("edit")]);
		},
		"Proceed.",
		false,
		confirmedRequest,
	);
	try {
		await f.waitFor(() => f.children.size === 1);
		const child = [...f.children.values()][0]!;
		expect(f.grant(child, "continue")?.scope.mode).toBe("edit");
		f.invalidateConfirmation();
		expect(f.grant(child, "continue")).toBeNull();
	} finally {
		await f.close();
	}
});

test("static evidence from the right execution still has to name a path in the grant", async () => {
	const f = await fixture((data) =>
		isAuthority(data)
			? { mode: "read" }
			: isPlan(data)
				? plan([proposal("read")])
				: {
						action: "accept",
						reason: "The source was read.",
						refs: ["outside-proof"],
					},
	);
	try {
		await f.waitFor(() => f.children.size === 1);
		const child = [...f.children.values()][0]!;
		f.complete(child, [
			{
				ref: "outside-proof",
				kind: "read",
				executionId: child.executionId!,
				text: "Unrelated source.",
				targetRevision: "base",
				inputDigest: "input-before",
				path: "other.ts",
			},
		]);
		await f.waitFor(() => f.view().status === "partial");
		expect(f.view().result?.refs).toEqual([]);
	} finally {
		await f.close();
	}
});
