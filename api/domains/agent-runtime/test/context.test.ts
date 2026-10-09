import { test, expect } from "bun:test";
import { workerContext } from "../service/context";
import {
	bytes,
	createCapabilities,
	migration,
	type Prepared,
} from "../../capabilities";
import { openStore } from "../../../infrastructure/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Source } from "../../tool-runtime";
import type { Task } from "../contracts";
async function builtinPrepared() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-worker-context-"));
	const store = openStore(join(dir, "db"), [migration]);
	const caps = createCapabilities(store);
	try {
		await caps.seed();
		const owner = { taskId: "worker", rootRunId: "root", cancelEpoch: 0 };
		return await store.write((db) => {
			const candidates = caps.searchInTransaction(
				db,
				owner,
				"調査",
				["web.research"],
				Date.now() + 10000,
			);
			const ref = candidates.find((c) => c.id === "web.research")!.candidateRef;
			return caps.prepareInTransaction(db, owner, ref, {
				question: "東京の天気",
			});
		});
	} finally {
		caps.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
test("only the selected profile and required skills become instructions; hints cannot introduce unbound tools", async () => {
	const base = await builtinPrepared();
	const selected = base.package;
	const definitions = base.dependencies;
	const extra = definitions
		.filter((d) => ["profile", "skill"].includes(d.kind))
		.map((d) => ({
			...d,
			revisionId: `${d.kind}:unused@1`,
			id: "unused",
			body: "UNSELECTED_ROLE_CHANGE",
		}));
	const prepared: Prepared = {
		package: selected,
		dependencies: [
			...definitions.filter((d) => d.kind !== "package"),
			...extra,
		],
		input: { question: "東京の天気" },
	};
	const task = {
		tool_calls: 0,
		model_calls: 0,
		json_repairs: 0,
		error_code: null,
	} as Task;
	const context = workerContext(task, prepared, [], [], [], {
		toolId: "web.quote",
		arguments: { symbol: "AAPL" },
	});
	expect(context.messages[0]!.content).toContain("公開情報の調査を担当");
	expect(context.messages[0]!.content).toContain("公開資料を調べて要約");
	expect(context.messages[0]!.content).not.toContain("UNSELECTED_ROLE_CHANGE");
	expect(JSON.parse(context.messages[1]!.content).nextInvocation).toBeNull();
	expect(() =>
		workerContext(
			task,
			{
				...prepared,
				dependencies: prepared.dependencies.filter(
					(d) => !selected.requiredSkillRevisionIds?.includes(d.revisionId),
				),
			},
			[],
			[],
			[],
		),
	).toThrow("required_context_missing");
});

test("escaped long requests retain mandatory instructions while optional observations fit the context budget", async () => {
	const base = await builtinPrepared();
	const selected = base.package;
	const definitions = base.dependencies;
	const question = "\\".repeat(8000);
	const profileBody = "MANDATORY_PROFILE " + "a".repeat(8000);
	const prepared: Prepared = {
		package: selected,
		dependencies: definitions
			.filter((d) => d.kind !== "package")
			.map((d) =>
				d.revisionId === selected.profileRevisionId
					? { ...d, body: profileBody }
					: d,
			),
		input: { question },
	};
	const sources: Source[] = Array.from({ length: 4 }, (_, i) => ({
		sourceId: `source-${i}`,
		url: `https://example.com/${i}`,
		title: "source",
		basis: "page",
		fetchedAt: "2026-10-09T00:00:00Z",
		truncated: false,
		body: "\\".repeat(4800),
	}));
	const task = {
		tool_calls: 0,
		model_calls: 0,
		json_repairs: 0,
		error_code: null,
	} as Task;
	const context = workerContext(task, prepared, [], sources, []);
	expect(bytes(context.messages)).toBeLessThanOrEqual(65536);
	expect(context.messages[0]!.content).toContain(profileBody);
	expect(context.messages[0]!.content).toContain("公開資料を調べて要約");
	const data = JSON.parse(context.messages[1]!.content);
	expect(data.task.question).toBe(question);
	expect(data.observations).toEqual(context.visible);
	expect(context.visible.length).toBeLessThan(sources.length);
});
