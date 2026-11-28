import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeInputDigest } from "../../coding";
import type {
	Host,
	Work,
	WorksDependencyRequest,
	WorksTarget,
} from "../contracts";
import { requestStop } from "../lifecycle";
import { worksAuthorization } from "../works-authorization";
import {
	answerWorksDependency,
	requestWorksDependency,
} from "../works-dependency";

test("a denial, cancellation, or changed input cannot enqueue a Works dependency", () => {
	const root = mkdtempSync("/tmp/works-dependency-control-");
	const folder = join(root, "src");
	mkdirSync(folder);
	const file = join(folder, "main.ts");
	const db = new Database(":memory:");
	const now = Date.now();
	const target: WorksTarget = {
		id: crypto.randomUUID(),
		generation: 1,
		name: "fixture",
		root,
		environment: "2.0",
		runtime: join(root, "releases", "2.0"),
		include: ["src"],
	};
	const workspace: Host["workspace"] = { hold: () => false, release() {} };
	const host: Host = {
		workspace,
		validSourceInTransaction: () => true,
		validReferenceInTransaction: () => true,
		controlSourceInTransaction: () => null,
		deliverInTransaction: () => false,
		revokeInTransaction() {},
		works: {
			select: () => target,
			current: () => true,
			workspace: () => workspace,
			runner() {
				throw new Error("unexpected start");
			},
			dependencies: {
				async publish() {
					throw new Error("unexpected publish");
				},
				advance() {
					throw new Error("unexpected advance");
				},
			},
		},
	};
	const proposed: WorksDependencyRequest = {
		name: "fixture-lib",
		version: "1.2.3",
		entry: "index.js",
		types: "index.d.ts",
		usage: "Format a label",
		evidenceRef: "check:1",
	};
	const deadline = now + 30_000;
	const authority = worksAuthorization(target, deadline);
	const prepare = () => {
		writeFileSync(file, "import 'fixture-lib';\n");
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(join(root, "README.md"), "fixture");
		writeFileSync(
			join(root, "prototype.json"),
			JSON.stringify({ environment: "2.0" }),
		);
		const digest = claudeInputDigest(
			[...authority.readablePaths, ...authority.writablePaths],
			undefined,
			true,
		)!;
		const executionId = crypto.randomUUID();
		const work = {
			id: crypto.randomUUID(),
			works: target,
			generation: 0,
			status: "deciding",
			source: {
				conversationId: "test",
				messageId: "source",
				runId: "trial",
				request: "Format a label",
				digest: "source",
			},
			deadline,
			references: [],
			executionId: null,
			holdsWorkspace: false,
			supervision: { authorization: authority },
			observation: {
				executionId,
				managedExecutionStopped: true,
				state: "finished",
				seq: 2,
				structuredEvidence: [
					{
						ref: "check:1",
						kind: "check",
						text: "missing",
						inputDigest: digest,
						executionId,
						targetRevision: authority.targetRevision,
						passed: false,
						check: authority.checks[0],
						stderr: "src/main.ts: prototype_import_unregistered fixture-lib",
					},
				],
			},
		} as unknown as Work;
		requestWorksDependency(db, host, work, proposed);
		expect(work.question?.prompt).toContain("fixture-lib@1.2.3");
		return work;
	};
	const unexpected = () => {
		throw new Error("unexpected queue admission");
	};
	try {
		const denied = prepare();
		expect(() =>
			answerWorksDependency(db, host, denied, "いいえ", now, unexpected),
		).toThrow("invalid_answer");
		answerWorksDependency(
			db,
			host,
			denied,
			"否認 " + denied.question!.id,
			now,
			unexpected,
		);
		expect(denied.status).toBe("partial");
		expect(denied.dependency).toBeUndefined();

		const changed = prepare();
		writeFileSync(file, "User replacement\n");
		answerWorksDependency(
			db,
			host,
			changed,
			"承認 " + changed.question!.id,
			now,
			unexpected,
		);
		expect(changed.result?.summary).toContain("更新");
		expect(changed.dependency).toBeUndefined();

		const cancelled = prepare();
		const code = "承認 " + cancelled.question!.id;
		requestStop(db, host, cancelled, "cancel", now);
		expect(cancelled.status).toBe("cancelled");
		expect(() =>
			answerWorksDependency(db, host, cancelled, code, now, unexpected),
		).toThrow("invalid_answer");
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
