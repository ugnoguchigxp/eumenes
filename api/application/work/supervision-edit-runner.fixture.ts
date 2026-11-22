import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Runner } from "../../domains/claude-code";
import {
	claudeInputDigest,
	type ClaudeObservation,
} from "../../domains/coding";

/** Runs the real regression command with a scripted edit during the ordinary fixed test. */
export function fixtureEditRunner(file: string): Runner {
	const observations = new Map<string, ClaudeObservation>();
	return {
		ready: () => true,
		supportsSupervised: () => true,
		probe: async () => true,
		async start(start) {
			if (!start.supervised) throw new Error("fixture_requires_grant");
			const { authorization } = start.supervised;
			expect(authorization.mode).toBe("edit");
			expect(authorization.writablePaths).toEqual([file]);
			const check = authorization.checks[0]!;
			const run = () => {
				const status = spawnSync(check.executable, check.args, {
					cwd: check.cwd,
					stdio: "pipe",
				}).status;
				if (status === null) throw new Error("fixture_check_did_not_exit");
				return status;
			};
			const digest = () => claudeInputDigest(authorization.readablePaths)!;
			expect(digest()).toBe(authorization.baselineInputDigest!);
			const before = digest();
			expect(run()).not.toBe(0);
			writeFileSync(
				file,
				"export const sum = (rows: number[]) => rows.length;\n",
			);
			expect(run()).toBe(0);
			const fact = {
				executionId: start.id,
				targetRevision: authorization.targetRevision,
				inputDigest: digest(),
			};
			const structuredEvidence = [
				{
					...fact,
					ref: "precheck",
					kind: "check" as const,
					check,
					inputDigest: before,
					text: "initial regression",
					passed: false,
				},
				{
					...fact,
					ref: "patch",
					kind: "edit" as const,
					path: file,
					text: "changed sum.ts",
				},
				{
					...fact,
					ref: "postcheck",
					kind: "check" as const,
					check,
					text: "post-edit regression",
					passed: true,
				},
			];
			const observed: ClaudeObservation = {
				executionId: start.id,
				seq: 1,
				state: "finished",
				managedExecutionStopped: true,
				supervised: start.supervised,
				structuredEvidence,
				evidence: structuredEvidence.map(({ ref, text }) => ({ ref, text })),
				turns: 1,
			};
			observations.set(start.id, observed);
			return observed;
		},
		inspect: async (id) => observations.get(id) ?? null,
		async stop(id) {
			return observations.get(id)!;
		},
		async present() {},
		async approveTool() {},
		async reply() {
			throw Error("unexpected reply");
		},
		async recover() {
			throw Error("unexpected recovery");
		},
	};
}
