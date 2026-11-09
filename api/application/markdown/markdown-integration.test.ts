import { expect, test } from "bun:test";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";
import type { ArchivePort } from "../../domains/markdown";
const archive: ArchivePort = {
	available: () => true,
	binding: () => "fixture",
	capabilities: async () => ({
		maxMarkdownBytes: 8388608,
		maxRecoveryBytes: 8388608,
		maxRequestBytes: 20971520,
		maxPageSize: 100,
	}),
	list: async () => ({ items: [], namespaces: ["eumenes"], nextCursor: null }),
	read: async () => {
		throw new Error("unused");
	},
	save: async (input) => ({
		sourceId: input.sourceId,
		documentId: input.documentId,
		title: input.title,
		revision: "desk-r1",
		path: input.path,
		namespace: input.namespace,
		contentDigest: input.contentDigest,
	}),
};
test("conversation switches to collaborator, edits arbitrary document ranges and reaches registered save through the ledger", async () => {
	const prompts: string[] = [];
	let stage = 0;
	const h = await harness({
		markdown: archive,
		routeTool: "markdown_edit",
		firstRound: (_tools, _question, messages) =>
			searchThenDelegate(
				(c) => c.id === "markdown.collaborate",
				"文書の共同編集を始めて",
				{ announcement: "文書の共同編集に切り替えます。", impact: "create" },
			)(messages),
		specialist: (messages) => {
			const prompt = messages.map((m) => m.content).join("\n");
			prompts.push(prompt);
			const revision = Number(
				/CURRENT_DOCUMENT path=document\.json revision=(\d+)/.exec(prompt)?.[1],
			);
			if (stage++ === 0)
				return {
					action: "invoke",
					tool: "doc.write",
					arguments: {
						baseRevision: revision,
						title: "企画",
						content: {
							formatVersion: 1,
							nodes: [
								{ type: "h1", children: [{ text: "初めの見出し" }] },
								{ type: "p", children: [{ text: "前の段落。" }] },
								{ type: "p", children: [{ text: "後の段落。" }] },
							],
							originalMarkdown: null,
						},
					},
					text: "文書を作りました。",
				};
			return {
				action: "invoke",
				tool: "doc.edit",
				arguments: {
					baseRevision: revision,
					edits: [
						{ old: "初めの見出し", new: "変更した見出し" },
						{ old: "後の段落。", new: "短い結論。" },
					],
				},
				text: "見出しと結論を直しました。",
			};
		},
	});
	try {
		const settings = h.settings.get();
		settings.routes.llm.mode = "larm-preferred";
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		async function say(text: string) {
			const response = await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			});
			expect(response.status).toBe(202);
			const run = await response.json();
			const done = await h.dialogue.waitForTerminal(run.id, {
				timeoutMs: 6000,
			});
			expect(done?.status, JSON.stringify(done)).toBe("completed");
			return run.id;
		}
		const first = await say("文書の共同編集を始めて");
		expect(h.dialogue.answerText(first)).toBe("文書を作りました。");
		const owner = (
			await (await h.request("/api/conversations/main/specialist")).json()
		).session;
		expect(owner).toMatchObject({
			toolchainId: "markdown.collaborate",
			adapterRef: "adapter:markdown@1",
			state: "active",
		});
		expect(prompts[0]).toContain("共同作業サブエージェント");
		await say("見出しと最後の段落を直して");
		expect(prompts).toHaveLength(2);
		const sourcePath =
			"/api/toolchain-artifacts/artifact:markdown.workspace@4/sources/markdown-workspace?params=" +
			encodeURIComponent(JSON.stringify({ workRef: owner.workRef }));
		const source = await (await h.request(sourcePath)).json();
		expect(source.data.current.title).toBe("企画");
		const text = JSON.stringify(source.data.current.document);
		expect(text).toContain("変更した見出し");
		expect(text).toContain("前の段落。");
		expect(text).toContain("短い結論。");
		const staged = await h.request("/api/markdown/inputs", {
			document: source.data.current.document,
			markdown: "# 変更した見出し\n\n前の段落。\n\n短い結論。\n",
		});
		expect(staged.status).toBe(201);
		const { id: stageId } = await staged.json();
		const artifact = await (
			await h.request("/api/toolchain-artifacts/artifact:markdown.workspace@4")
		).json();
		const event = {
			version: 1,
			eventId: crypto.randomUUID(),
			eventCreatedAt: new Date().toISOString(),
			eventExpiresAt: new Date(Date.now() + 60000).toISOString(),
			artifactId: "fixture-tab",
			artifactRevisionId: "artifact:markdown.workspace@4",
			source: "markdown-workspace",
			sourceRevision: source.revision,
			actionId: "archive",
			scopeRef: artifact.scopeRef,
			input: {
				documentId: source.data.current.id,
				expectedRevision: String(source.data.current.revision),
				stageId,
			},
		};
		const saved = await h.request("/api/toolchain-actions", event);
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({
			status: "accepted",
			result: { receipt: { state: "saving" } },
		});
		await h.queue.tick();
		for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
		const final = await (await h.request(sourcePath)).json();
		expect(final.data.current).toMatchObject({
			sourceId: expect.stringMatching(/^wiki-[a-f0-9]{32}$/),
			saveState: "saved",
			dirty: false,
		});
		const replay = await h.request("/api/toolchain-actions", event);
		expect(replay.status).toBe(200);
		expect(replay.headers.get("idempotent-replay")).toBe("true");
	} finally {
		await h.close();
	}
});

test("the authenticated upload route accepts documents above the shared 1 MiB cap and keeps its own 20 MiB bound", async () => {
	const h = await harness({ markdown: archive });
	try {
		const body = JSON.stringify({
			document: {
				formatVersion: 1,
				nodes: [{ type: "p", children: [{ text: "日本語".repeat(150000) }] }],
				originalMarkdown: null,
			},
		});
		const post = (
			text: string,
			token = "fixture-token-for-toolchain-browser",
		) =>
			h.app.request("/api/markdown/inputs", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					"content-length": String(Buffer.byteLength(text)),
				},
				body: text,
			});
		expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024);
		expect((await post(body, "wrong-token")).status).toBe(401);
		const saved = await post(body);
		expect(saved.status).toBe(201);
		expect(await saved.json()).toMatchObject({ id: expect.any(String) });
		const tooBig = await post(" ".repeat(20 * 1024 * 1024 + 1));
		expect(tooBig.status).toBe(413);
		expect(await tooBig.json()).toEqual({ error: "payload_too_large" });
		const ordinary = await h.app.request("/api/runs", {
			method: "POST",
			headers: {
				authorization: "Bearer fixture-token-for-toolchain-browser",
				"content-type": "application/json",
				"content-length": String(Buffer.byteLength(body)),
			},
			body,
		});
		expect(ordinary.status).toBe(413);
	} finally {
		await h.close();
	}
});

test("the public capability projection exposes limits and feature flags without opaque upstream extension values", async () => {
	const { createDocling } = await import("../../domains/docling"),
		{ markdownArchive } = await import("./markdown-composition");
	const service = createDocling({
		connection: () => null,
		status: () => ({ revision: 0, configured: false, publicOrigin: null }),
		fileConnection: () => ({
			baseUrl: "https://larm.test",
			credential: "fixture-backend-only",
		}),
		fetch: async () =>
			Response.json({
				contractVersion: "larm.docling-files.v1",
				basePath: "/v1/docling/documents",
				requiresDocling: false,
				methods: ["GET", "PUT", "DELETE", "FUTURE"],
				delete: { opaque: "upstream-extension-value" },
				maxRequestBytes: 20971520,
				maxMarkdownBytes: 8388608,
				maxRecoveryBytes: 8388608,
				maxPageSize: 100,
				contentDigest: "sha256(ascii(markdownSha256 + LF + recoverySha256))",
			}),
	});
	const caps = await markdownArchive(service).capabilities(
		AbortSignal.timeout(5000),
	);
	expect(caps.maxMarkdownBytes).toBe(8388608);
	expect(caps.features?.delete).toBe(false);
	expect(JSON.stringify(caps)).not.toContain("upstream-extension-value");
	expect(JSON.stringify(caps)).not.toContain("fixture-backend-only");
});

test("management metadata excludes document bodies while retaining validated identity and digests", async () => {
	const { createDocling, documentDigests } =
			await import("../../domains/docling"),
		{ markdownArchive } = await import("./markdown-composition");
	const id = `wiki-${"a".repeat(32)}`,
		etag = `"${"b".repeat(64)}"`,
		markdown = "\uFEFF# 本文\r\n末尾  \r\n",
		recovery = '{"style":"太字"}',
		digests = documentDigests(markdown, recovery);
	const service = createDocling({
		connection: () => null,
		status: () => ({ revision: 0, configured: false, publicOrigin: null }),
		fileConnection: () => ({
			baseUrl: "https://larm.test",
			credential: "fixture",
		}),
		fetch: async (url) =>
			url.pathname.endsWith("capabilities")
				? Response.json({
						contractVersion: "larm.docling-files.v1",
						basePath: "/v1/docling/documents",
						requiresDocling: false,
						methods: ["GET", "PUT"],
						maxRequestBytes: 20971520,
						maxMarkdownBytes: 8388608,
						maxRecoveryBytes: 8388608,
						maxPageSize: 100,
						contentDigest:
							"sha256(ascii(markdownSha256 + LF + recoverySha256))",
					})
				: Response.json(
						{
							id,
							etag,
							namespace: "eumenes",
							path: "元.md",
							title: "原題",
							updatedAt: "2026-11-08T15:00:00Z",
							markdown,
							recovery,
							...digests,
						},
						{ headers: { ETag: etag } },
					),
	});
	const metadata = await markdownArchive(service).management!.getEntry(
		"document",
		id,
		AbortSignal.timeout(5000),
	);
	expect(metadata).toMatchObject({
		kind: "document",
		id,
		etag,
		contentDigest: digests.contentDigest,
		updatedAt: "2026-11-08T15:00:00Z",
	});
	expect(metadata).not.toHaveProperty("markdown");
	expect(metadata).not.toHaveProperty("recovery");
});
