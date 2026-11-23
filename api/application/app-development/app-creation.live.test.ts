import { expect, test } from "bun:test";
import { createLiveLarm } from "../../../scripts/live-larm";
import { fixture } from "./app-development.fixture";
import type { createGitObservation } from "../../domains/git-observation";
import type { AcquisitionPort } from "../../domains/web-research";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configureLogging, flushLogging } from "../../infrastructure/logger";
import { createHash } from "node:crypto";
import { fieldsOfDefinition } from "../../domains/ui-compositions";

/** Frozen user-level requests. The parent, routing, authoring and runtime models are real. */
const cases = [
	{
		kind: "records",
		request:
			"読んだ本の題名と感想を記録して、後から感想を編集できるアプリを作ってください。",
	},
	{
		kind: "list",
		request:
			"検証劇場の上映作品と開始時刻を日付ごとに確認できるアプリを作ってください。日付を入力して更新し、作品ごとに時刻を並べたいです。",
	},
	{
		kind: "journal",
		request:
			"接続中のGitHubでsample_から始まるリポジトリの変更を毎日確認し、開発日誌をライブラリへ保存するアプリを作ってください。",
	},
] as const;
const amendment =
	"感想の入力欄を題名より前に並べてください。記録の内容はそのまま残してください。";

const git: ReturnType<typeof createGitObservation> = async () => ({
	enumerationComplete: true,
	units: [
		{
			unitId: "repo-one",
			repository: "sample_app",
			branch: "main",
			state: "baseline",
			evidenceRefs: ["fixture:repository:one"],
			candidate: { key: "repo-one", previous: null, current: "a".repeat(40) },
			commits: "基準コミット",
			changes: "",
			truncated: false,
		},
	],
});
const acquisition: AcquisitionPort = {
	close: async () => {},
	execute: async (request) => {
		const at = new Date().toISOString();
		return {
			freshUntilMs: null,
			bodies:
				request.operation === "read"
					? [
							{
								url: request.url,
								title: "検証劇場の上映一覧",
								fetchedAt: at,
								text: "# 検証劇場\n# 2026-11-23\n## 検証作品\n11:30",
								acquisitionTruncated: false,
							},
						]
					: [],
			result: {
				provider: "llm-fetch@0.1.4-eumenes.1",
				observedAt: at,
				cache: "bypass",
				documents: [],
				failures: [],
				hits:
					request.operation === "lookup"
						? [
								{
									url: "https://example.com/timetable",
									title: "検証劇場 公式上映一覧",
									provider: "fixture",
									snippet: "11月23日の上映一覧",
									trust: "untrusted",
									tainted: true,
									verification: "search_summary",
								},
							]
						: [],
			},
		};
	},
};

test.skipIf(process.env.EUMENES_APP_CREATION_LIVE !== "1")(
	"nine frozen conversational app creations reach confirmed save and first use",
	async () => {
		const directory = join(
			process.cwd(),
			"verification-reports",
			"web-app-creation-live",
		);
		mkdirSync(directory, { recursive: true });
		const runAt = new Date().toISOString().replaceAll(":", "-");
		const inputHash = createHash("sha256")
			.update(JSON.stringify({ cases, amendment }))
			.digest("hex");
		const bundleHash = createHash("sha256")
			.update(
				await Bun.file(
					"api/domains/capabilities/bundles/app-development.bundle.json",
				).text(),
			)
			.digest("hex");
		const harnessHash = createHash("sha256")
			.update(
				await Bun.file(
					"api/application/app-development/app-development.fixture.ts",
				).text(),
			)
			.digest("hex");
		configureLogging({
			file: join(directory, `${runAt}.jsonl`),
			destination: { write() {} },
		});
		const observations: Array<{
			kind: string;
			iteration: number;
			status: string;
			phase: string;
			elapsedMs: number;
		}> = [];
		try {
			for (const sample of cases)
				for (let iteration = 1; iteration <= 3; iteration++) {
					const start = performance.now();
					let status = "failed";
					let phase = "create";
					const model = createLiveLarm(process.env, { agentSessions: true });
					let clock = Date.now();
					const h = await fixture({
						request: sample.request,
						draft: null,
						git,
						timerNow: () => clock,
						live: { model, acquisition },
					});
					const candidates: Array<Array<{ id: string; revisionId: string }>> =
						[];
					const route = h.routing.routeInTransaction.bind(h.routing);
					h.routing.routeInTransaction = (db, input) => {
						const result = route(db, input);
						candidates.push(
							result.cards.map(({ id, revisionId }) => ({ id, revisionId })),
						);
						return result;
					};
					try {
						const id = await h.create(0);
						phase = "first-use";
						const viewing = (await h.source(id)).data.viewing;
						if (sample.kind === "records") {
							const storage = viewing.storage;
							expect(storage).toBeTruthy();
							const title = storage.columns.find((column: { label: string }) =>
								/題名|タイトル|書名/.test(column.label),
							)?.name;
							const memo = storage.columns.find((column: { label: string }) =>
								/感想|メモ/.test(column.label),
							)?.name;
							expect(title).toBeTruthy();
							expect(memo).toBeTruthy();
							await h.action(
								"storage-record",
								{
									appId: id,
									revision: String(viewing.savedRevision),
									collection: storage.collection,
									record: JSON.stringify({
										operation: "create",
										values: { [title]: "検証用の本", [memo]: "初回の感想" },
									}),
								},
								id,
							);
							const row = (await h.source(id)).data.viewing.storage.rows[0];
							await h.action(
								"storage-record",
								{
									appId: id,
									revision: String(viewing.savedRevision),
									collection: storage.collection,
									record: JSON.stringify({
										operation: "update",
										id: row.id,
										expectedRevision: row.revision,
										values: { ...row.values, [memo]: "編集後の感想" },
									}),
								},
								id,
							);
							expect(
								(await h.source(id)).data.viewing.storage.rows[0].values[memo],
							).toBe("編集後の感想");
							if (iteration === 1) {
								phase = "amend";
								await h.propose(amendment);
								expect(await h.confirm()).toBe(id);
								const changed = (await h.source(id)).data.viewing;
								const fields = fieldsOfDefinition(changed.definition) ?? [];
								const titleIndex = fields.findIndex((field) =>
									/題名|タイトル|書名/.test(field.label),
								);
								const memoIndex = fields.findIndex((field) =>
									/感想|メモ/.test(field.label),
								);
								expect(memoIndex).toBeGreaterThanOrEqual(0);
								expect(titleIndex).toBeGreaterThan(memoIndex);
								expect(changed.storage.rows[0].values[memo]).toBe(
									"編集後の感想",
								);
							}
						} else if (sample.kind === "list") {
							const values = Object.fromEntries(
								Object.values(viewing.bindings.inputs).map((key) => [
									String(key),
									"2026-11-23",
								]),
							);
							await h.action(
								"run",
								{
									appId: id,
									revision: String(viewing.savedRevision),
									values: JSON.stringify(values),
								},
								id,
							);
							const result = await h.completed(id);
							expect(JSON.stringify(result.result.value)).toContain("検証作品");
							expect(JSON.stringify(result.result.value)).toContain("11:30");
						} else {
							expect(viewing.workflow.trigger).toBe("schedule");
							await h.action(
								"schedule",
								{
									appId: id,
									revision: String(viewing.savedRevision),
									anchor: new Date(clock + 1000).toISOString(),
								},
								id,
							);
							clock += 1001;
							await h.scheduler.tick();
							h.queue.wake();
							await h.completed(id);
							expect(h.documents.size).toBe(1);
						}
						status = "passed";
					} catch (error) {
						const runs = h.dialogue
							.list("main")
							.map(({ id, status, error, specialistSessionId }) => ({
								id,
								status,
								error,
								specialistSessionId,
							}));
						writeFileSync(
							join(
								directory,
								`${runAt}-${sample.kind}-${iteration}-failure.json`,
							),
							JSON.stringify({ phase, candidates, runs }, null, 2) + "\n",
						);
						// Accepted replies from this isolated fixture, separate from operational logs and raw provider output.
						writeFileSync(
							join(directory, `${runAt}-${sample.kind}-${iteration}-answer.md`),
							"# 受入が停止した会話の採用済み回答\n\n" +
								h.conversation
									.get("main")
									.messages.filter((message) => message.role === "assistant")
									.map((message) => message.text)
									.join("\n\n")
									.slice(-8000) +
								"\n",
						);
						throw error;
					} finally {
						observations.push({
							kind: sample.kind,
							iteration,
							status,
							phase,
							elapsedMs: Math.round(performance.now() - start),
						});
						await h.close();
						await model.close();
					}
					console.log(JSON.stringify(observations.at(-1)));
				}
		} finally {
			flushLogging();
			writeFileSync(
				join(directory, `${runAt}.json`),
				JSON.stringify(
					{
						inputHash,
						bundleHash,
						harnessHash,
						conversationSystem:
							"agencyReplyParts/defaults/no-background-agenda",
						cases: cases.map(({ kind }) => kind),
						observations,
						passed: observations.filter((item) => item.status === "passed")
							.length,
					},
					null,
					2,
				) + "\n",
			);
		}
	},
	4 * 60 * 60 * 1000,
);
