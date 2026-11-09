import {
	date,
	movie,
	place,
	url,
	indexUrl,
	movies,
	journal,
	name,
	fixture,
	readLocalSettings,
} from "./app-development.fixture";
import {
	adoptWorkflowCheckpointsInTransaction,
	workflowCheckpointsInTransaction,
	workflowRevisionInTransaction,
} from "../../domains/pipelines";
import { sha256Hex } from "../../infrastructure/digest";
import { createCapabilities } from "../../domains/capabilities";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
import { createLiveLarm } from "../../../scripts/live-larm";
import { createDocling } from "../../domains/docling";
import { markdownArchive } from "../markdown/markdown-composition";
import { resolveLarmToken } from "../../infrastructure/auth-config";
import { readStoredLarm } from "../../domains/settings";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitObservation } from "../../domains/git-observation";
import { waitFor } from "../../infrastructure/wait-for";
import { workflowCheckpointOwner } from "./workflow-operations";
import {
	expandShowtimesGroups,
	numberedLines,
	showtimesClockLines,
	showtimesFromLines,
	showtimesGroupsForClockLines,
	showtimesSectionTimes,
	showtimesTitleLines,
	type SourceLine,
} from "./workflow-showtimes";

test("rejects a draft that fixes a Web URL absent from the request", async () => {
	const request = "指定日の検証劇場の公式上映一覧をアプリで見たい";
	const h = await fixture({
		request,
		draft: {
			...movies,
			workflow: {
				...movies.workflow,
				input: {
					...movies.workflow.input,
					fixed: { ...movies.workflow.input.fixed, sourceUrl: indexUrl },
				},
			},
		},
		git: createGitObservation("/unused"),
	});
	try {
		await h.propose(request);
		const { work, history } = (await h.source()).data;
		expect(work.confirmation).toBeNull();
		expect(work.rejected.issues).toContainEqual(
			expect.objectContaining({
				path: "workflow.input.fixed.sourceUrl",
				rule: "workflow_source_url_unconfirmed",
			}),
		);
		expect(history).toEqual([]);
	} finally {
		await h.close();
	}
}, 20000);

test("a screening format can be verified on its own line below the screen", () => {
	const lines: SourceLine[] = [];
	numberedLines(
		[
			{
				ref: "source",
				text: "## 作品名\n- シアター\n  特別上映\n  2D\n  11:30~12:50\n  購入\n## 次の作品\n- 14:15〜16:00\n更新時刻 10:05",
			},
		],
		0,
		lines,
	);
	const group = {
		titleLine: 1,
		format: { line: 4, text: "2D" },
		showings: [5],
	};
	const result = {
		theater: place,
		date,
		coverage: "complete" as const,
		groups: [group],
	};
	expect(showtimesFromLines(result, lines).rows).toEqual([
		{
			title: "作品名",
			startTime: "11:30",
			format: "2D",
			evidenceRefs: ["source"],
		},
	]);
	const clockLines = showtimesClockLines(lines);
	expect(clockLines).toEqual([5, 8, 9]);
	const titles = showtimesTitleLines(lines);
	expect(titles).toEqual([1, 7]);
	const evidenceSchema = showtimesGroupsForClockLines(clockLines, titles);
	const sections = showtimesSectionTimes(lines);
	const condensed = evidenceSchema.parse({
		...result,
		groups: [{ title: 1, format: [4, "2D"], times: "all" }],
	});
	expect(expandShowtimesGroups(condensed, sections)).toEqual(result);
	const withRangeEnd = evidenceSchema.parse({
		...result,
		groups: [{ title: 1, format: [4, "2D"], times: [[5, 2]] }],
	});
	expect(expandShowtimesGroups(withRangeEnd, sections)).toEqual(result);
	expect(() =>
		expandShowtimesGroups(
			evidenceSchema.parse({
				...result,
				groups: [{ title: 1, format: [4, "2D"], times: [8] }],
			}),
			sections,
		),
	).toThrow("workflow_web_evidence_invalid");
	expect(
		evidenceSchema.safeParse({
			...result,
			groups: [{ title: 1, format: [4, "2D"], times: [5] }],
		}).success,
	).toBe(true);
	expect(
		evidenceSchema.safeParse({
			...result,
			groups: [{ title: 1, format: [4, "2D"], times: [6] }],
		}).success,
	).toBe(false);
	expect(
		evidenceSchema.safeParse({
			...result,
			groups: [{ title: 2, format: [4, "2D"], times: [5] }],
		}).success,
	).toBe(false);
	expect(() =>
		showtimesFromLines(
			{ ...result, groups: [{ ...group, format: { line: 2, text: "2D" } }] },
			lines,
		),
	).toThrow("workflow_web_evidence_invalid");
});

test("an indented list continuation stays with its evidence item across saved views", () => {
	const lines: SourceLine[] = [];
	const text = numberedLines(
		[
			{ ref: "first", text: "## 作品名\n- 会場\n\n  設備\n\n" },
			{ ref: "second", text: "   2D\n   90分\n- 11:30~13:00\n\n  購入" },
		],
		0,
		lines,
		"list-items",
	);
	expect(text).toBe(
		"1|## 作品名\n2|- 会場 | 設備 | 2D | 90分\n3|- 11:30~13:00 | 購入",
	);
	expect(showtimesClockLines(lines)).toEqual([3]);
	const data = showtimesFromLines(
		{
			theater: place,
			date,
			coverage: "complete",
			groups: [
				{ titleLine: 1, format: { line: 2, text: "2D" }, showings: [3] },
			],
		},
		lines,
	);
	expect(data.rows[0]).toEqual({
		title: "作品名",
		startTime: "11:30",
		format: "2D",
		evidenceRefs: ["first", "second"],
	});
	expect(() =>
		showtimesFromLines(
			{
				theater: place,
				date,
				coverage: "complete",
				groups: [
					{
						titleLine: 1,
						format: { line: 2, text: "設備 | 2D" },
						showings: [3],
					},
				],
			},
			lines,
		),
	).toThrow("workflow_web_evidence_invalid");
});

test("natural language → app draft → confirmed save → protected Web → OpenUI data source", async () => {
	let rejectRefresh = false;
	const h = await fixture({
		request: "指定日の検証劇場の上映作品と時刻をアプリで見たい",
		draft: movies,
		git: createGitObservation("/unused"),
		beforeExtract: () => {
			if (rejectRefresh) throw new Error("deadline_exceeded");
		},
	});
	try {
		const oldCapabilities = createCapabilities(
			h.store,
			new Set(["ui-compositions"]),
			{ bundleHost: offlineBundleHost },
		);
		await oldCapabilities.seed();
		await h.store.write((db) => {
			const stamp = Date.now();
			db.run(
				"INSERT INTO ui_compositions(id,scope,title,definition_json,fields_json,state,saved_revision,created_at,updated_at) VALUES(?,?,?,?,NULL,'ready',1,?,?)",
				[
					"old-ui",
					"default",
					"旧履歴の画面",
					JSON.stringify({ view: "text-block", title: "旧画面" }),
					stamp,
					stamp,
				],
			);
		});
		const launch = await (await h.request("/api/toolchain-artifacts")).json();
		expect(JSON.stringify(launch)).toContain("Webアプリ開発");
		expect(JSON.stringify(launch)).not.toContain("UI自由制作");
		expect((await h.source()).data.history).toEqual([]);
		const id = await h.create();
		expect(existsSync(join(h.dir, "app-storage"))).toBe(false);
		expect((await h.source(id)).data.viewing.storage).toBeNull();
		expect((await h.source(id)).data.viewing.bindings.sections).toEqual(
			movies.screen.bindings.sections,
		);
		const runValues = {
			appId: id,
			revision: "1",
			values: JSON.stringify({ date }),
		};
		await h.action("run", runValues, id);
		const first = await h.completed(id);
		expect(first.result.value).toMatchObject({
			theater: place,
			date,
			rows: [{ title: movie, startTime: "11:30" }],
		});
		const data = (await h.source(id)).data.viewing.data;
		expect(data.rows[0].title).toBe(movie);
		expect(data.rows[0].evidenceRefs).toHaveLength(2);
		expect(h.calls).toEqual(["search", "select", "navigate", "extract"]);
		expect(h.readUrls).toEqual([indexUrl, url]);
		await h.action("run", runValues, id);
		const second = await h.completed(id, first.runId);
		expect(h.readUrls).toEqual([indexUrl, url, url]);
		expect(h.calls).toEqual([
			"search",
			"select",
			"navigate",
			"extract",
			"extract",
		]);
		rejectRefresh = true;
		await h.action("run", runValues, id);
		await waitFor(async () => {
			const { status } = (await h.source(id)).data.viewing;
			return (
				status.runId !== second.runId &&
				["failed", "expired"].includes(status.state)
			);
		});
		expect((await h.source(id)).data.viewing.data).toMatchObject({
			date,
			rows: [{ title: movie, startTime: "11:30" }],
		});
		const failed = (await h.source(id)).data.viewing.status.runId;
		await h.action(
			"run",
			{ ...runValues, values: JSON.stringify({ date: "2026-11-10" }) },
			id,
		);
		await waitFor(async () => {
			const { status } = (await h.source(id)).data.viewing;
			return (
				status.runId !== failed && ["failed", "expired"].includes(status.state)
			);
		});
		expect((await h.source(id)).data.viewing.data).toBeNull();
	} finally {
		await h.close();
	}
}, 20000);

test("a verified date URL survives failure of the final extraction", async () => {
	let attempts = 0;
	const h = await fixture({
		request: "指定日の検証劇場の公式上映情報を表示するアプリを作って",
		draft: movies,
		git: createGitObservation("/unused"),
		beforeExtract: () => {
			if (++attempts === 1) throw new Error("deadline_exceeded");
		},
	});
	try {
		const id = await h.create();
		const values = {
			appId: id,
			revision: "1",
			values: JSON.stringify({ date }),
		};
		await h.action("run", values, id);
		let failed;
		await waitFor(async () => {
			failed = (await h.source(id)).data.viewing.status;
			return ["failed", "expired"].includes(failed?.state);
		});
		expect(failed).toBeTruthy();
		expect(h.readUrls).toEqual([indexUrl, url]);
		await h.action("run", values, id);
		await h.completed(id, (failed as { runId: string } | undefined)?.runId);
		expect(h.readUrls).toEqual([indexUrl, url, url]);
		expect(h.calls).toEqual([
			"search",
			"select",
			"navigate",
			"extract",
			"extract",
		]);
	} finally {
		await h.close();
	}
}, 20000);

test("an official entry survives failure before navigation to the requested day", async () => {
	let attempts = 0;
	const h = await fixture({
		request: "指定日の検証劇場の公式上映情報を表示するアプリを作って",
		draft: movies,
		git: createGitObservation("/unused"),
		beforeNavigation: () => {
			if (++attempts === 1) throw new Error("deadline_exceeded");
		},
	});
	try {
		const id = await h.create();
		const values = {
			appId: id,
			revision: "1",
			values: JSON.stringify({ date }),
		};
		await h.action("run", values, id);
		await waitFor(async () =>
			["failed", "expired"].includes(
				(await h.source(id)).data.viewing.status?.state,
			),
		);
		const failed = (await h.source(id)).data.viewing.status.runId;
		await h.action("run", values, id);
		await h.completed(id, failed);
		expect(h.readUrls).toEqual([indexUrl, indexUrl, url]);
		expect(h.calls).toEqual([
			"search",
			"select",
			"navigate",
			"navigate",
			"extract",
		]);
	} finally {
		await h.close();
	}
}, 20000);

test("natural language → daily reservation → real Git fetch/diff → durable Markdown → next checkpoint", async () => {
	const dir = mkdtempSync(join(tmpdir(), "app-git-"));
	const command = (args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", dir, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	};
	command(["init", "-b", "main"]);
	command(["config", "user.name", "Fixture"]);
	command(["config", "user.email", "fixture@example.com"]);
	function commit(text: string) {
		writeFileSync(join(dir, "sample.txt"), text);
		command(["add", "sample.txt"]);
		command(["commit", "-m", text.trim()]);
	}
	commit("最初の版\n");
	let now = Date.now();
	const git = createGitObservation(join(dir, "observer"), {
		list: async () => ({
			repositories: [{ id: "1", name, owner: "fixture", branch: "main" }],
			complete: true,
		}),
		remote: () => dir,
	});
	const h = await fixture({
		request: "eumenes_で始まるGitHubリポジトリの差分を毎日開発日誌に保存して",
		draft: journal,
		git,
		timerNow: () => now,
	});
	try {
		const id = await h.create();
		const anchor = now + 1000;
		await h.action(
			"schedule",
			{ appId: id, revision: "1", anchor: new Date(anchor).toISOString() },
			id,
		);
		expect((await h.source(id)).data.viewing.status.schedule.intervalMs).toBe(
			86_400_000,
		);
		const direct = await h.request("/api/schedules", {
			requestId: crypto.randomUUID(),
			target: {
				kind: "workflow.run",
				payload: { definitionId: id, revision: 1 },
			},
			schedule: {
				type: "interval",
				anchor: new Date(anchor).toISOString(),
				intervalMs: 86_400_000,
			},
		});
		expect(direct.status).toBeGreaterThanOrEqual(400);
		now = anchor;
		expect(await h.scheduler.tick()).toBe(1);
		const first = await h.completed(id);
		expect(first.result.checkpointCount).toBe(1);
		commit("二回目の変更\n");
		now += 86_400_000;
		expect(await h.scheduler.tick()).toBe(1);
		const second = await h.completed(id, first.runId);
		expect(second.result.checkpointCount).toBe(1);
		expect(h.observed.map((unit) => unit.state)).toEqual([
			"baseline",
			"changed",
		]);
		expect(h.observed[1]?.changes).toContain("二回目の変更");
		expect(h.documents.size).toBe(2);
		expect([...h.documents.values()].at(-1)?.markdown).toContain(
			"二回目の変更",
		);
	} finally {
		await h.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 30000);

async function liveArchive() {
	const env = process.env;
	const saved = readStoredLarm(env.EUMENES_DB || "./data/eumenes.sqlite3");
	const credential = resolveLarmToken(env);
	if (!saved.baseUrl || !credential)
		throw new Error("live_docling_unconfigured");
	const setting = (await readLocalSettings("docling")) as {
		gatewayUrl: string;
		publicOrigin: string;
		revision: number;
	};
	const connection = {
		...setting,
		credential,
		version: "app-workflow-verification:" + setting.revision,
	};
	const docling = createDocling({
		connection: () => connection,
		fileConnection: () => ({ baseUrl: saved.baseUrl!, credential }),
		status: () => ({
			revision: setting.revision,
			publicOrigin: setting.publicOrigin,
			configured: true,
		}),
	});
	return markdownArchive(docling);
}

const liveEnabled = process.env.EUMENES_APP_WORKFLOW_LIVE === "1";

const scoreRow = (
	row: { title: string; startTime: string; format?: string } | string[],
) =>
	(Array.isArray(row) ? row : [row.title, row.startTime, row.format ?? ""])
		.map((part) => (part ?? "").normalize("NFKC").replace(/\s+/g, " ").trim())
		.join("|");
test.skipIf(!liveEnabled)(
	"live official showtimes and real LLM from a natural-language app request",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "app-live-web-"));
		const model = createLiveLarm(process.env, {
			agentSessions: true,
		});
		const h = await fixture({
			request:
				"109シネマズ湘南の上映作品・開始時刻・上映形式を確認するアプリを作って。日付を入力すると公式サイトの当日の全上映回を表示し、作品名を見出しに、その下に各回の開始時刻と上映形式を並べてください。2Dの表示名は「通常」にしてください。",
			draft: null,
			git: createGitObservation(join(dir, "git")),
			live: { model },
		});
		try {
			const id = await h.create();
			const started = performance.now();
			await h.action(
				"run",
				{ appId: id, revision: "1", values: JSON.stringify({ date }) },
				id,
			);
			const output = (await h.completed(id)).result.value as {
				coverage: string;
				rows: Array<{
					title: string;
					startTime: string;
					format?: string;
				}>;
				evidence: Array<{ url: string }>;
			};
			const sources = [...new Set(output.evidence.map((item) => item.url))];
			const snapshot = (await h.source(id)).data;
			expect(snapshot.viewing.workflow.input.fixed.sourceUrl).toBeUndefined();
			expect(snapshot.viewing.bindings.sections).toMatchObject({
				rowsKey: "rows",
				groupBy: "title",
				itemKeys: ["startTime", "format"],
				labels: { format: { "2D": "通常" } },
			});
			expect(snapshot.viewing.data.rows).toHaveLength(57);
			const expectedRows = (await Bun.file(
				"spec/verification/reusable-content-workflows-2026-11-09/expected-rows.json",
			).json()) as Record<string, string[][]>;
			const expected = expectedRows["shonan-" + date]!.map(scoreRow).sort();
			const actual = output.rows.map(scoreRow).sort();
			const result = {
				durationMs: Math.round(performance.now() - started),
				expected: expected.length,
				actual: actual.length,
				coverage: output.coverage,
				matches: JSON.stringify(actual) === JSON.stringify(expected),
			};
			if (process.env.EUMENES_APP_WORKFLOW_RESULTS) {
				await Bun.write(
					process.env.EUMENES_APP_WORKFLOW_RESULTS + "/showtimes.json",
					JSON.stringify(
						{ ...result, sources, expectedRows: expected, actualRows: actual },
						null,
						2,
					),
				);
				await Bun.write(
					process.env.EUMENES_APP_WORKFLOW_RESULTS + "/showtimes-app.json",
					JSON.stringify(snapshot),
				);
			}
			expect(result).toMatchObject({
				expected: 57,
				actual: 57,
				coverage: "complete",
				matches: true,
			});
			expect(result.durationMs).toBeLessThanOrEqual(60000);
			expect(sources).toContain(
				"https://109cinemas.net/shonan/schedules/20261109.html?theater_code=R1",
			);
		} finally {
			await h.close();
			await model.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	450000,
);

test.skipIf(!liveEnabled)(
	"live GitHub ownership scope and daily Markdown in Docling",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "app-live-journal-"));
		const model = createLiveLarm(process.env, {
			agentSessions: true,
		});
		const archive = await liveArchive();
		const path = "検証/Eumenesアプリ開発-" + crypto.randomUUID();
		let now = Date.now();
		const git = createGitObservation(join(dir, "git"));
		const changed = new Set<string>();
		const h = await fixture({
			request:
				"接続中のGitHubアカウントで、名前がeumenes_で始まる所有リポジトリの変更を毎日開発日誌にしてDoclingへ保存するアプリを作って。初回は基準登録として記録してください。",
			draft: null,
			git: async (...args) => {
				const result = await git(...args);
				for (const unit of result.units)
					if (unit.state === "changed" && unit.candidate)
						changed.add(unit.unitId);
				return result;
			},
			timerNow: () => now,
			live: { model, archive, destination: { namespace: "eumenes", path } },
		});
		try {
			const id = await h.create();
			expect((await h.source(id)).data.viewing.workflow.input.fixed).toEqual({
				connectionRef: "connection:github-projects",
				repositoryPrefix: "eumenes_",
			});
			now = Date.now();
			const anchor = now + 1000;
			await h.action(
				"schedule",
				{ appId: id, revision: "1", anchor: new Date(anchor).toISOString() },
				id,
			);
			now = anchor;
			expect(await h.scheduler.tick()).toBe(1);
			const finished = await h.completed(id);
			const doc = await archive.read(
				"wiki-" + finished.runId.replaceAll("-", ""),
				AbortSignal.timeout(15000),
			);
			expect(doc.entry.path.startsWith(path + "/")).toBe(true);
			expect(doc.markdown.trim().length).toBeGreaterThan(0);
			if (process.env.EUMENES_APP_WORKFLOW_RESULTS)
				await Bun.write(
					process.env.EUMENES_APP_WORKFLOW_RESULTS + "/journal-first.json",
					JSON.stringify({
						documentId: doc.entry.sourceId,
						checkpointCount: finished.result.checkpointCount,
					}),
				);
			expect(finished.result.checkpointCount).toBeGreaterThan(0);
			await h.store.write((db) => {
				const saved = workflowRevisionInTransaction(db, "default", id, 1)!;
				const owner = workflowCheckpointOwner(
					"default",
					id,
					saved.value.definition,
				);
				const cursors = workflowCheckpointsInTransaction(db, owner);
				for (const [key, tip] of Object.entries(cursors)) {
					const repositoryId = key.split(":")[0]!;
					const cache = join(dir, "git", sha256Hex(repositoryId));
					const parent = Bun.spawnSync(
						["git", "-C", cache, "rev-parse", "--verify", `${tip}^`],
						{ stdout: "pipe", stderr: "ignore" },
					);
					const previous = parent.stdout.toString().trim();
					if (parent.exitCode || !/^[0-9a-f]{40}$/.test(previous)) continue;
					const size = Bun.spawnSync(
						[
							"git",
							"-C",
							cache,
							"diff",
							"--no-ext-diff",
							"--no-textconv",
							"--stat",
							"--patch",
							previous,
							tip,
						],
						{ stdout: "pipe", stderr: "ignore" },
					);
					if (
						size.exitCode ||
						!size.stdout.length ||
						size.stdout.length > 32000
					)
						continue;
					expect(
						adoptWorkflowCheckpointsInTransaction(db, owner, [
							{ key, previous: tip, current: previous },
						]),
					).toBe(true);
					return;
				}
				throw new Error("live_github_no_prior_commit");
			});
			now += 86_400_000;
			expect(await h.scheduler.tick()).toBe(1);
			const next = await h.completed(id, finished.runId);
			const second = await archive.read(
				"wiki-" + next.runId.replaceAll("-", ""),
				AbortSignal.timeout(15000),
			);
			expect(second.entry.path.startsWith(path + "/")).toBe(true);
			expect(second.markdown.trim()).not.toBe(doc.markdown.trim());
			expect(changed.size).toBeGreaterThan(0);
			expect(next.result.checkpointCount).toBeGreaterThan(0);
			const result = {
				checkpointCount: finished.result.checkpointCount,
				documentId: doc.entry.sourceId,
				savedPath: doc.entry.path,
				bytes: Buffer.byteLength(doc.markdown),
				actualGitHub: true,
				verifiedChanged: changed.size,
				secondDocumentId: second.entry.sourceId,
				modelAuthoredContent: true,
				archiveReadback: true,
			};
			if (process.env.EUMENES_APP_WORKFLOW_RESULTS)
				await Bun.write(
					process.env.EUMENES_APP_WORKFLOW_RESULTS + "/journal.json",
					JSON.stringify(result, null, 2),
				);
			expect(result.checkpointCount).toBeGreaterThan(0);
		} finally {
			await h.close();
			await model.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	500000,
);
