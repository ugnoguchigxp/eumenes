import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeInputDigest } from "../../domains/coding";
import type {
	SupervisionChildEvidence,
	SupervisionScope,
} from "../../domains/development-supervision";
import { migrations as workspaceMigrations } from "../../domains/kanban";
import { waitFor } from "../../infrastructure/wait-for";
import { runGoalCheck } from "../agency/goal-verification";
import { supervisionWorkspace } from "./supervision-workspace";
import { hash } from "../../domains/capabilities";
import { fixture } from "../../domains/development-supervision/test/fixture";
import type { GoalExecutionSource } from "../../domains/tool-runtime";

const target = {
	toolchainRevisionId: "toolchain:development-supervision.request@1",
	bindingRevisionId: "binding:development-supervision.managed@1",
};
test("a goal receipt survives restart and cannot project into a conversation or another goal", async () => {
	const request = "Read the authorized document.";
	const expectedObservation = "Read receipt for the actual document.";
	const source: GoalExecutionSource = {
		origin: "goal",
		runId: crypto.randomUUID(),
		principal: "owner",
		scopeKey: "work",
		goalId: "chat",
		goalRevision: 1,
		attemptId: crypto.randomUUID(),
		permitId: crypto.randomUUID(),
		permitRevision: 1,
		request,
		expectedObservation,
		digest: hash([request, expectedObservation]),
		...target,
	};
	let permitted = true;
	const f = await fixture(
		() => ({ mode: "design", quote: "", reason: "fixture" }),
		undefined,
		false,
		{
			authorityInTransaction: (_db, value) =>
				permitted && hash(value) === hash(source)
					? {
							workspace: { workspaceRef: "test", targetRevision: "base" },
							scope: {
								workspaceRef: "test",
								targetRevision: "base",
								mode: "read",
								deadline: Date.now() + 60_000,
								readablePaths: ["manual.md"],
								writablePaths: [],
								checks: [],
							},
							design: null,
						}
					: null,
		},
	);
	try {
		const accept = (value: GoalExecutionSource) =>
			f.withWriter((db, owner) =>
				owner.goal.startInTransaction(db, value, target),
			);
		const first = await accept(source);
		expect((await accept(source)).ownerWorkId).toBe(first.ownerWorkId);
		await expect(accept({ ...source, goalId: "other" })).rejects.toThrow(
			"supervision_source_invalid",
		);
		permitted = false;
		const acceptedBeforeRestart = f.children.size;
		await f.restart();
		await f.withWriter((db, owner) => {
			expect(owner.goal.lookupInTransaction(db, source)?.ownerWorkId).toBe(
				first.ownerWorkId,
			);
			expect(owner.task.viewInTransaction(db, first.ownerWorkId)).toBeNull();
			expect(
				owner
					.boardRowsInTransaction(db, { conversationId: source.goalId })
					.every((row) => row.parentId !== first.ownerWorkId),
			).toBe(true);
			expect(() =>
				owner.goal.lookupInTransaction(db, { ...source, principal: "other" }),
			).toThrow("supervision_goal_conflict");
			expect(
				db
					.query(
						"SELECT owner_kind, owner_key FROM development_supervision_work WHERE id=?",
					)
					.get(first.ownerWorkId),
			).toEqual({ owner_kind: "goal", owner_key: source.goalId });
		});
		expect(f.children.size).toBe(acceptedBeforeRestart);
	} finally {
		await f.close();
	}
});

test.skipIf(process.platform !== "darwin")(
	"the next real workspace admission uses a released goal edit and blocks a third-party change",
	async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "goal-owned-edit-")));
		const outside = resolve(
			import.meta.dir,
			"../../../spec/verification/goal-autonomy-2026-11-23",
		);
		cpSync(join(outside, "workspace"), root, { recursive: true });
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
		git("init", "-q");
		git("add", ".");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=test@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"initial",
		);
		const head = git("rev-parse", "HEAD");
		const readme = join(root, "README.md");
		const sample = join(root, "sample.mjs");
		const baseline = readFileSync(readme, "utf8");
		const text = baseline.replace("--style json", "--format text");
		const corrected = baseline.replace("--style json", "--format json");
		const check = {
			executable: process.execPath,
			args: [join(outside, "check-readme.ts"), root],
			cwd: root,
		};
		const scope: SupervisionScope = {
			workspaceRef: "goal-test",
			targetRevision: head,
			deadline: Date.now() + 60_000,
			mode: "edit",
			readablePaths: [readme, sample],
			writablePaths: [readme],
			checks: [check],
		};
		const document = {
			documentId: crypto.randomUUID(),
			digest: "saved-design",
		};
		const permitId = crypto.randomUUID();
		const owner = (request: string): GoalExecutionSource => {
			const expectedObservation = "JSON calculation.";
			return {
				origin: "goal",
				runId: crypto.randomUUID(),
				goalId: "goal",
				goalRevision: 1,
				principal: "owner",
				scopeKey: "work",
				attemptId: crypto.randomUUID(),
				permitId,
				permitRevision: 1,
				request,
				expectedObservation,
				digest: hash([request, expectedObservation]),
				...target,
			};
		};
		const f = await fixture(
			(data) =>
				"child" in data
					? { action: "finish", reason: "Observed result", status: "partial" }
					: { mode: "design", quote: "", reason: "fixture" },
			undefined,
			false,
			{
				authorityInTransaction: (_db, origin) =>
					origin.permitId === permitId
						? {
								scope,
								design: document,
								workspace: {
									workspaceRef: scope.workspaceRef,
									targetRevision: head,
									rootPath: root,
								},
							}
						: null,
			},
			supervisionWorkspace(root, scope.workspaceRef),
			workspaceMigrations,
		);
		try {
			f.designs.set(document.documentId, {
				...document,
				title: "Repair",
				markdown: "Keep the original output conditions.",
				uri: "resource:design:fixture",
			});
			const start = (source: GoalExecutionSource) =>
				f.withWriter((db, service) =>
					service.goal.startInTransaction(db, source, target),
				);
			const receipt = (source: GoalExecutionSource) =>
				f.withWriter((db, service) =>
					service.goal.lookupInTransaction(db, source),
				);
			const startChild = async (parentId: string) => {
				await waitFor(() =>
					[...f.children.values()].some(
						({ start }) => start.source.delegation.parentWorkId === parentId,
					),
				);
				return [...f.children.values()].find(
					({ start }) => start.source.delegation.parentWorkId === parentId,
				)!;
			};
			const signal = AbortSignal.timeout(5_000);
			const execute = () =>
				runGoalCheck(
					root,
					{
						ref: "check",
						command: check.executable,
						args: check.args,
						cwd: root,
					},
					signal,
				);
			const first = owner("First edit.");
			const accepted = await start(first);
			const child = await startChild(accepted.ownerWorkId);
			writeFileSync(readme, text);
			const mismatch = await execute();
			expect(mismatch.exitCode).toBe(1);
			expect(JSON.parse(mismatch.stdout)).toMatchObject({
				reason: "unexpected_output",
				exitCode: 0,
				stdout: "count=3, total=12",
			});
			const proof = (executionId: string): SupervisionChildEvidence => ({
				ref: "child-edit",
				executionId,
				kind: "edit",
				targetRevision: head,
				path: readme,
				inputDigest: claudeInputDigest(scope.readablePaths)!,
				text: "Changed owned file",
			});
			f.complete(child, [proof(child.executionId!)], "partial");
			await waitFor(async () => (await receipt(first))?.status === "partial");
			const stored = await f.withWriter((db) =>
				db
					.query(
						"SELECT json_extract(data,'$.tasks[0].ownedEdit.after.inputDigest') AS digest FROM development_supervision_work WHERE id=?",
					)
					.get(accepted.ownerWorkId),
			);
			expect(stored).toEqual({
				digest: claudeInputDigest(scope.readablePaths),
			});
			writeFileSync(readme, text + "\nthird-party change\n");
			const second = owner("Second edit with the same permit.");
			const next = await start(second);
			await waitFor(() =>
				f.withWriter(
					(db) =>
						(
							db
								.query(
									"SELECT json_extract(data,'$.tasks[0].state') AS state FROM development_supervision_work WHERE id=?",
								)
								.get(next.ownerWorkId) as { state: string }
						).state === "held",
				),
			);
			expect(f.children.size).toBe(1);
			writeFileSync(readme, text);
			const reaccepted = await startChild(next.ownerWorkId);
			expect(reaccepted.start.source.delegation.parentWorkId).toBe(
				next.ownerWorkId,
			);
			writeFileSync(readme, corrected);
			const result = await execute();
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(JSON.parse(result.stdout).stdout)).toEqual({
				count: 3,
				total: 12,
			});
			expect(git("diff", "--name-only", head)).toBe("README.md");
			const {
				principal,
				scopeKey,
				goalId,
				goalRevision,
				attemptId,
				permitId,
				permitRevision,
			} = first;
			await f.withWriter((db, service) =>
				service.goal.forgetInTransaction(
					db,
					{
						principal,
						scopeKey,
						goalId,
						goalRevision,
						attemptId,
						permitId,
						permitRevision,
					},
					first.runId,
				),
			);
			await waitFor(() =>
				f.withWriter((db) =>
					Boolean(
						db
							.query(
								"SELECT 1 FROM development_supervision_work WHERE id=? AND forgotten=1 AND pending=0 AND json_extract(data,'$.request')=''",
							)
							.get(accepted.ownerWorkId),
					),
				),
			);
			expect(
				await f.withWriter((db) =>
					db
						.query(
							"SELECT id FROM development_supervision_grants WHERE parent_id=?",
						)
						.all(accepted.ownerWorkId),
				),
			).toEqual([]);
		} finally {
			await f.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	10_000,
);

test("an owned check preserves its witnessed failure after a later execution supplies another observation", async () => {
	const request = "Check the published behavior.";
	const expectedObservation = "The actual exit and error.";
	const source: GoalExecutionSource = {
		origin: "goal",
		runId: crypto.randomUUID(),
		principal: "owner",
		scopeKey: "work",
		goalId: "history",
		goalRevision: 1,
		attemptId: crypto.randomUUID(),
		permitId: crypto.randomUUID(),
		permitRevision: 1,
		request,
		expectedObservation,
		digest: hash([request, expectedObservation]),
		...target,
	};
	const check = { executable: "bun", args: ["run", "validate"], cwd: "." };
	const f = await fixture(
		() => ({ mode: "design", quote: "", reason: "fixture" }),
		undefined,
		false,
		{
			authorityInTransaction: () => ({
				scope: {
					workspaceRef: "test",
					targetRevision: "base",
					mode: "verify",
					deadline: Date.now() + 60_000,
					readablePaths: ["manual.md"],
					writablePaths: [],
					checks: [check],
				},
				design: null,
				workspace: { workspaceRef: "test", targetRevision: "base" },
			}),
		},
	);
	try {
		const accepted = await f.withWriter((db, owner) =>
			owner.goal.startInTransaction(db, source, target),
		);
		const receipt = () =>
			f.withWriter((db, owner) => owner.goal.lookupInTransaction(db, source));
		const find = () =>
			[...f.children.values()].find(
				({ start }) =>
					start.source.delegation.parentWorkId === accepted.ownerWorkId,
			);
		await waitFor(() => !!find());
		const child = find()!;
		const previousExecution = child.executionId!;
		child.executionId = crypto.randomUUID();
		child.diagnosticChecks = [
			{
				ref: "recorded-check",
				kind: "check",
				targetRevision: "base",
				executionId: previousExecution,
				check,
				passed: false,
				exitCode: 2,
				stderr: "Unknown option",
				text: "Tool failure",
			},
		];
		f.complete(child, []);
		await waitFor(async () => (await receipt())?.status === "failed");
		expect(await receipt()).toMatchObject({
			ownerWorkId: accepted.ownerWorkId,
			result: {
				status: "failed",
				summary: expect.stringContaining(
					"終了コード 2\n標準エラー Unknown option",
				),
			},
			evidence: [
				expect.objectContaining({
					ref: "recorded-check",
					exitCode: 2,
					executionId: previousExecution,
				}),
			],
		});
	} finally {
		await f.close();
	}
});
