import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	GoalPermitScope,
	GoalWorkPermission,
} from "eumenes-agency/agenda/runtime";
import { z } from "zod";
import { goalDigest } from "./goal-progress-context";

const checkRegistration = z.strictObject({
	ref: z.string().min(1),
	description: z.string().min(1),
	command: z.string().min(1),
	args: z.array(z.string()),
	cwd: z.string().min(1),
	acceptance: z.boolean().default(false),
	expectedJson: z.json().optional(),
});
const registry = z.array(
	z.strictObject({
		ref: z.string().min(1),
		root: z.string().min(1),
		readablePaths: z.array(z.string().min(1)).min(1),
		writablePaths: z.array(z.string().min(1)),
		checks: z.array(checkRegistration),
		policyCheckRefs: z.array(z.string().min(1)).default([]),
	}),
);
type Registration = z.infer<typeof registry>[number];
function within(root: string, file: string) {
	const rel = relative(root, file);
	return (
		!isAbsolute(rel) &&
		rel !== ".." &&
		!rel.startsWith(".." + sep) &&
		!rel.split(sep).includes(".git")
	);
}
function checkedPath(root: string, path: string) {
	const textPath = resolve(root, path);
	const physical = realpathSync(textPath);
	if (
		!within(root, textPath) ||
		!within(root, physical) ||
		textPath !== physical
	)
		throw new Error("goal_workspace_path_forbidden");
	return physical;
}
/**
 * The baseline of a read-only policy permit. Commits to the workspace do not revoke and reissue it; what was
 * read is identified by the read files' content digests, and a check runs against the HEAD of its moment.
 */
export const READ_POLICY_BASELINE = "read-policy:current-head";

/** The commit a permit's work and checks run against: the HEAD now for a read-only policy permit. */
export function permitBaseline(
	workspaces: { revision(root: string): string },
	permit: { workspace: string; scope: { baselineCommit: string } },
): string {
	return permit.scope.baselineCommit === READ_POLICY_BASELINE
		? workspaces.revision(permit.workspace)
		: permit.scope.baselineCommit;
}

function revision(root: string) {
	return execFileSync(
		"git",
		[
			"--no-optional-locks",
			"-C",
			root,
			"rev-parse",
			"--verify",
			"HEAD^{commit}",
		],
		{
			timeout: 2_000,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
		},
	).trim();
}
function registeredCheck(root: string, entry: Registration["checks"][number]) {
	const command = realpathSync(entry.command);
	const cwd = checkedPath(root, entry.cwd);
	if (!lstatSync(command).isFile() || !lstatSync(cwd).isDirectory())
		throw new Error("goal_workspace_check_forbidden");
	return {
		ref: entry.ref,
		command,
		args: entry.args,
		cwd,
		...(entry.expectedJson === undefined
			? {}
			: { expectationDigest: goalDigest(entry.expectedJson) }),
	};
}
export function createGoalWorkspaceRegistry(raw: string | undefined) {
	const registrations = raw ? registry.parse(JSON.parse(raw)) : [];
	const workspaces = new Map<string, Registration>();
	for (const item of registrations) {
		if (
			workspaces.has(item.ref) ||
			new Set(item.checks.map(({ ref }) => ref)).size !== item.checks.length
		)
			throw new Error("goal_workspace_registration_conflict");
		const root = realpathSync(item.root);
		revision(root);
		if (
			new Set(item.policyCheckRefs).size !== item.policyCheckRefs.length ||
			item.policyCheckRefs.some(
				(ref) =>
					!item.checks.some((check) => check.ref === ref && check.acceptance),
			)
		)
			throw new Error("goal_workspace_policy_check_invalid");
		for (const ref of item.policyCheckRefs)
			registeredCheck(
				root,
				item.checks.find((check) => check.ref === ref)!,
			);
		workspaces.set(item.ref, { ...item, root });
	}
	function readPolicies(revisionId: string) {
		return [...workspaces.values()].flatMap((workspace) => {
			try {
				const scope: GoalPermitScope = {
					version: 1,
					workspaceRef: workspace.ref,
					basis: { kind: "policy", revision: revisionId },
					// A read-only policy is not tied to a commit: work and checks read the HEAD of their moment.
					baselineCommit: READ_POLICY_BASELINE,
					readablePaths: workspace.readablePaths.map((path) =>
						checkedPath(workspace.root, path),
					),
					writablePaths: [],
					checks: workspace.policyCheckRefs.map((ref) =>
						registeredCheck(
							workspace.root,
							workspace.checks.find((check) => check.ref === ref)!,
						),
					),
					expiresAtMs: null,
				};
				return [{ scope, workspace: workspace.root, impact: "read" as const }];
			} catch {
				return [];
			}
		});
	}
	return {
		get: (ref: string) => workspaces.get(ref),
		runnerWorkspaces: () => [...workspaces.values()],
		readPolicies,
		readPolicy(revisionId: string) {
			return workspaces.size === 1
				? (readPolicies(revisionId)[0] ?? null)
				: null;
		},
		check(workspaceRef: string, ref: string) {
			const workspace = workspaces.get(workspaceRef);
			const entry = workspace?.checks.find((item) => item.ref === ref);
			if (!workspace || !entry) return null;
			try {
				return registeredCheck(workspace.root, entry);
			} catch {
				return null;
			}
		},
		list: () =>
			[...workspaces.values()].map(
				({ ref, readablePaths, writablePaths, checks }) => ({
					ref,
					readablePaths,
					writablePaths,
					checks: checks.map(({ ref, description }) => ({ ref, description })),
				}),
			),
		revision,
		resolve(request: GoalWorkPermission, sourceRef: string) {
			const workspace = workspaces.get(request.workspaceRef);
			if (!workspace) return null;
			const root = workspace.root;
			try {
				const readAllowed = workspace.readablePaths.map((path) =>
					checkedPath(root, path),
				);
				const writeAllowed = new Set(
					workspace.writablePaths.map((path) => checkedPath(root, path)),
				);
				const read = request.readablePaths.map((path) =>
					checkedPath(root, path),
				);
				const write = request.writablePaths.map((path) =>
					checkedPath(root, path),
				);
				if (
					read.some(
						(path) => !readAllowed.some((allowed) => within(allowed, path)),
					) ||
					write.some(
						(path) => !writeAllowed.has(path) || !lstatSync(path).isFile(),
					) ||
					(request.mode === "edit" ? write.length === 0 : write.length > 0) ||
					(request.mode === "read" && request.checkRefs.length > 0)
				)
					return null;
				const checks = [...new Set(request.checkRefs)].map((ref) => {
					const entry = workspace.checks.find((check) => check.ref === ref);
					if (!entry) throw new Error("goal_workspace_check_unknown");
					return registeredCheck(root, entry);
				});
				const scope: GoalPermitScope = {
					version: 1,
					workspaceRef: workspace.ref,
					basis: { kind: "message", sourceRefs: [sourceRef] },
					baselineCommit: revision(root),
					readablePaths: read,
					writablePaths: write,
					checks,
					expiresAtMs: null,
				};
				return { scope, workspace: root, impact: request.mode };
			} catch {
				return null;
			}
		},
	};
}
export type GoalWorkspaceRegistry = ReturnType<
	typeof createGoalWorkspaceRegistry
>;
