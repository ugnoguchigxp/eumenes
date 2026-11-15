import { expect, test } from "bun:test";
import { createDocling, documentDigests } from "../../domains/docling";
import { markdownArchive } from "./markdown-composition";
import { waitFor } from "../../infrastructure/wait-for";
import { harness, workerPacket } from "../toolchain/toolchain.fixture";

const title = "沿岸観測所の運用手順";
const finding = "交換間隔は17週間。";
const request = `LARMの保存文書「${title}」で交換間隔を確認して`;
const followup = "さっきの調査結果の版と根拠を教えて";
const entry = {
	sourceId: "wiki-0123456789abcdef0123456789abcdef",
	title,
	revision: `"${"a".repeat(64)}"`,
	namespace: "operations",
	path: "stations/coast.md",
};
const first = "前書き。".repeat(400);
const second = `\n## センサーの保守\n${finding}\n`;

function archiveFixture() {
	let credential = "fixture-larm-backend-only";
	const calls: string[] = [];
	const markdown = first + second;
	const recovery = "";
	const document = {
		id: entry.sourceId,
		etag: entry.revision,
		title,
		namespace: entry.namespace,
		path: entry.path,
		...documentDigests(markdown, recovery),
	};
	const docling = createDocling({
		connection: () => null,
		status: () => ({ revision: 0, configured: true, publicOrigin: null }),
		fileConnection: () => ({ baseUrl: "https://larm.test", credential }),
		fetch: async (url, init) => {
			expect(init.method ?? "GET").toBe("GET");
			expect(new Headers(init.headers).get("authorization")).toBe(
				`Bearer ${credential}`,
			);
			const base = "/v1/docling/documents";
			if (url.pathname === "/v1/docling/capabilities") {
				calls.push("capabilities");
				return Response.json({
					contractVersion: "larm.docling-files.v1",
					basePath: base,
					requiresDocling: false,
					methods: ["GET", "PUT"],
					maxPageSize: 30,
					maxMarkdownBytes: 80000,
					maxRecoveryBytes: 80000,
					maxRequestBytes: 160000,
					contentDigest: "sha256(ascii(markdownSha256 + LF + recoverySha256))",
				});
			}
			if (url.pathname === base) {
				const cursor = url.searchParams.get("cursor");
				calls.push(`list:${cursor ?? "first"}`);
				return cursor === "second"
					? Response.json({
							documents: [document],
							namespaces: ["operations"],
							nextCursor: null,
						})
					: Response.json({
							documents: [],
							namespaces: ["operations"],
							nextCursor: "second",
						});
			}
			expect(url.pathname).toBe(`${base}/${entry.sourceId}`);
			calls.push(`read:${entry.sourceId}`);
			return Response.json(
				{ ...document, markdown, recovery },
				{ headers: { ETag: document.etag } },
			);
		},
	});
	return {
		archive: markdownArchive(docling),
		calls,
		rebind: () => {
			credential = "replacement-binding";
		},
	};
}

test("conversation delegates remote-only document search and cites the version and later body range", async () => {
	const fixture = archiveFixture();
	let workerCalls = 0;
	const h = await harness({
		markdown: fixture.archive,
		pipelines: true,
		routeTool: "resource_research",
		discoveryTarget: () => "resource_research",
		firstRound(_tools, question, messages) {
			if (question !== followup) return undefined;
			if (messages.some((message) => message.content.includes("原文位置")))
				return { text: `${finding} 参照「${title}」${entry.revision}。` };
			return {
				calls: [{ name: "work", args: { operation: "check", todo: "t1" } }],
			};
		},
		parent(messages) {
			const message = messages.find((m) => m.content.includes("原文位置"));
			return message
				? `${finding} 参照「${title}」${entry.revision}。`
				: "お調べします。";
		},
		control(messages) {
			const data = workerPacket(messages);
			const invoke = (tool: string, args: object) =>
				JSON.stringify({ action: "invoke", tool, arguments: args });
			const list = data.operations.filter(
				(op: any) => op.tool === "archive.search",
			);
			const reads = data.operations.filter(
				(op: any) => op.tool === "archive.read",
			);
			workerCalls++;
			expect(data.reportMode).toBe("search");
			if (list.length === 0)
				return invoke("archive.search", { terms: ["沿岸観測所"] });
			if (list.length === 1)
				return invoke("archive.search", {
					terms: ["沿岸観測所"],
					pageRef: list[0].notes.nextPageRef,
				});
			const documentRef = list.at(-1).notes.matches[0].documentRef;
			if (reads.length === 0)
				return invoke("archive.read", { documentRef, offset: 0 });
			if (reads.length === 1)
				return invoke("archive.read", {
					documentRef,
					offset: reads[0].notes.nextOffset,
				});
			const evidence = data.observations
				.flatMap((source: any) => source.excerpts)
				.find((excerpt: any) => excerpt.quote.includes(finding));
			expect(evidence).toBeDefined();
			return JSON.stringify({
				action: "finish",
				report: {
					outcome: "answered",
					summary: finding,
					claims: [{ text: finding, evidence: [evidence.reference] }],
					limitations: [],
				},
			});
		},
	});
	try {
		const response = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: request,
		});
		expect(response.status).toBe(202);
		await waitFor(() => !!h.reported(), { timeout: 5000 });
		const reported = JSON.parse(h.reported());
		const schema = h.store.read((db) =>
			h.toolchain.capabilities.schemaInTransaction(
				db,
				"schema:resource.research.result@1",
			),
		);
		expect(schema?.safeParse(reported).success).toBe(true);
		expect(reported.report.sources).toEqual([
			expect.objectContaining({
				kind: "archive_document",
				title,
				revision: entry.revision,
				start: first.length,
				end: first.length + second.length,
			}),
		]);
		expect(JSON.stringify(reported)).not.toContain("fixture-larm-backend-only");
		const notices = await (await h.request("/api/todo-notices")).json();
		expect(notices.notices[0].summary).toContain(finding);
		expect(notices.notices[0].summary).toContain("版");
		expect(notices.notices[0].summary).toContain(
			`原文位置 ${first.length}–${first.length + second.length}`,
		);
		const consulted = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: followup,
		});
		expect(consulted.status).toBe(202);
		const { id } = (await consulted.json()) as { id: string };
		await waitFor(() => !!h.dialogue.answerText(id), { timeout: 5000 });
		expect(h.dialogue.answerText(id)).toContain(finding);
		expect(h.parentContexts.join("\n")).toContain(
			`原文位置 ${first.length}–${first.length + second.length}`,
		);
		expect(h.commandContexts).toHaveLength(0);
		expect(workerCalls).toBe(5);
		expect(fixture.calls).toEqual([
			"capabilities",
			"list:first",
			"list:second",
			`read:${entry.sourceId}`,
			`read:${entry.sourceId}`,
		]);
		const workspaces = h.store.read((db) =>
			db.query("SELECT count(*) AS n FROM markdown_workspaces").get(),
		);
		expect(workspaces).toEqual({ n: 0 });
	} finally {
		await h.close();
	}
}, 18000);

test("the selected worker cannot use an unissued document reference", async () => {
	const fixture = archiveFixture();
	const h = await harness({
		markdown: fixture.archive,
		pipelines: true,
		routeTool: "resource_research",
		discoveryTarget: () => "resource_research",
		control: () =>
			JSON.stringify({
				action: "invoke",
				tool: "archive.read",
				arguments: { documentRef: crypto.randomUUID(), offset: 0 },
			}),
	});
	try {
		const response = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: request,
		});
		expect(response.status).toBe(202);
		await waitFor(() => !!h.reported(), { timeout: 5000 });
		expect(JSON.parse(h.reported())).toMatchObject({ status: "failed" });
		expect(fixture.calls).toEqual([]);
	} finally {
		await h.close();
	}
}, 9000);

test("a connection change invalidates body evidence before the worker result can be adopted", async () => {
	const fixture = archiveFixture();
	const h = await harness({
		markdown: fixture.archive,
		pipelines: true,
		routeTool: "resource_research",
		discoveryTarget: () => "resource_research",
		control(messages) {
			const data = workerPacket(messages);
			const calls = data.operations;
			const search = (pageRef?: string) => ({
				action: "invoke",
				tool: "archive.search",
				arguments: { terms: ["沿岸観測所"], pageRef },
			});
			if (calls.length < 2)
				return JSON.stringify(search(calls[0]?.notes.nextPageRef));
			if (calls.length === 2)
				return JSON.stringify({
					action: "invoke",
					tool: "archive.read",
					arguments: {
						documentRef: calls[1].notes.matches[0].documentRef,
						offset: first.length,
					},
				});
			fixture.rebind();
			return JSON.stringify({
				action: "finish",
				report: {
					outcome: "answered",
					summary: finding,
					claims: [
						{
							text: finding,
							evidence: [data.observations[0].excerpts[0].reference],
						},
					],
					limitations: [],
				},
			});
		},
	});
	try {
		const response = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: request,
		});
		expect(response.status).toBe(202);
		await waitFor(() => !!h.reported(), { timeout: 5000 });
		expect(JSON.parse(h.reported())).toMatchObject({
			status: "failed",
			code: "evidence_invalidated",
		});
		expect(h.reported()).not.toContain(finding);
		expect(fixture.calls).toEqual([
			"capabilities",
			"list:first",
			"list:second",
			`read:${entry.sourceId}`,
		]);
	} finally {
		await h.close();
	}
}, 9000);
