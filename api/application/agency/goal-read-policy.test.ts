import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	GoalAttempt,
	GoalPermit,
	GoalProgress,
} from "eumenes-agency/agenda/runtime";
import { createGoalVerification } from "./goal-verification";
import {
	createGoalWorkspaceRegistry,
	permitBaseline,
	READ_POLICY_BASELINE,
} from "./goal-workspaces";

/** A git checkout with a registered acceptance check, as the Live2D work area is registered. */
function checkout() {
	const root = mkdtempSync("/tmp/goal-read-policy-");
	const git = (...argv: string[]) =>
		execFileSync("git", ["-C", root, ...argv], { stdio: "pipe" });
	writeFileSync(join(root, "feature.json"), JSON.stringify({ ready: true }));
	git("init", "-q");
	const commit = (message: string) =>
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qam",
			message,
		);
	git("add", "feature.json");
	commit("first");
	return { root, commit };
}

const registration = (root: string) => ({
	ref: "avatar",
	root,
	readablePaths: ["feature.json"],
	writablePaths: [],
	policyCheckRefs: ["behavior"],
	checks: [
		{
			ref: "behavior",
			description: "既存の機能を試験で確かめる",
			acceptance: true,
			command: "/bin/cat",
			args: ["feature.json"],
			cwd: ".",
		},
	],
});

test("a read-only policy is not tied to a commit, and works against the HEAD of its moment", () => {
	const { root, commit } = checkout();
	try {
		const workspaces = createGoalWorkspaceRegistry(
			JSON.stringify([registration(root)]),
		);
		const [policy] = workspaces.readPolicies("read@1");
		expect(policy!.scope.baselineCommit).toBe(READ_POLICY_BASELINE);
		const before = workspaces.revision(root);
		expect(permitBaseline(workspaces, policy!)).toBe(before);
		writeFileSync(join(root, "feature.json"), JSON.stringify({ ready: false }));
		commit("second");
		const [again] = workspaces.readPolicies("read@1");
		expect(again!.scope).toEqual(policy!.scope);
		expect(permitBaseline(workspaces, again!)).not.toBe(before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("after the goal read the work area under its permit, the registered check is offered even if the worker did not conclude", () => {
	const { root, commit } = checkout();
	try {
		const workspaces = createGoalWorkspaceRegistry(
			JSON.stringify([registration(root)]),
		);
		const [policy] = workspaces.readPolicies("read@1");
		const permit = {
			...policy!,
			id: "permit:1",
			revision: 1,
			revoked: false,
		} as unknown as GoalPermit;
		let attempts: GoalAttempt[] = [];
		const goals = {
			goalPermitsInTransaction: () => [permit],
			goalAttemptsInTransaction: () => attempts,
		} as never;
		const verification = createGoalVerification({
			goals,
			workspaces,
			sourcesCurrent: () => true,
		});
		const row = {
			principal: "owner",
			goalId: "goal-1",
			goalRevision: 1,
			ledgerScope: "work",
			state: { criteria: [{ id: "root", status: "open", evidenceRefs: [] }] },
		} as unknown as GoalProgress;
		const db = {} as never;
		expect(verification.checks(db, row)).toEqual([]);
		attempts = [
			{
				permitId: "permit:1",
				permitRevision: 1,
				outcome: "failed",
				evidenceRefs: ["read:1"],
				step: { criterionIds: ["root"] },
			} as unknown as GoalAttempt,
		];
		expect(verification.checks(db, row)).toMatchObject([
			{ criterionIds: ["root"], permitId: "permit:1" },
		]);
		writeFileSync(
			join(root, "feature.json"),
			JSON.stringify({ ready: true }, null, 1),
		);
		commit("unrelated change");
		expect(verification.checks(db, row)).toHaveLength(1);
		attempts = [{ ...attempts[0]!, outcome: "running" } as GoalAttempt];
		expect(verification.checks(db, row)).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
