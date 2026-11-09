import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../toolchain/toolchain.fixture";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { researchScript } from "../../domains/pursuit/test/model.fixture";
import { createScratchStore } from "../../domains/scratch";
import type { ArchivePort } from "../../domains/markdown";
import type { ArchivedDocument } from "../../domains/markdown/contracts";
import { waitFor } from "../../infrastructure/wait-for";

for (const online of [true, false]) {
	test(`public research produces an exact Markdown file and a truthful Docling receipt (online=${online})`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "eumenes-research-document-")),
			scratch = createScratchStore({
				root: dir,
				freeBytes: () => 20 * 1024 ** 3,
			});
		scratch.start();
		const saved = new Map<string, ArchivedDocument>();
		let puts = 0;
		const archive: ArchivePort = {
			binding: () => (online ? "fixture" : null),
			available: () => online,
			capabilities: async () => ({
				maxMarkdownBytes: 8388608,
				maxRecoveryBytes: 8388608,
				maxRequestBytes: 20971520,
				maxPageSize: 100,
			}),
			list: async () => ({
				items: [...saved.values()].map((d) => d.entry),
				namespaces: ["eumenes"],
				nextCursor: null,
			}),
			read: async (id) => saved.get(id)!,
			save: async (input) => {
				puts++;
				const document = {
					markdown: input.markdown,
					recovery: input.recovery,
					entry: {
						sourceId: input.sourceId,
						title: input.title,
						namespace: input.namespace,
						path: input.path,
						contentDigest: input.contentDigest,
						revision: `"${"a".repeat(64)}"`,
					},
				};
				saved.set(input.sourceId, document);
				return document.entry;
			},
		};
		const script = researchScript({ document: true }),
			request = "複数の一次資料を比較して出典と限界を整理して";
		const h = await harness({
			scratch,
			markdown: archive,
			pursuit: script,
			discoveryTarget: () => "web_research",
			firstRound: (_tools, _question, messages) =>
				searchThenDelegate((c) => c.id === "web.research", request, {
					impact: "create",
					announcement: "詳しく調査します。",
				})(messages),
			acquisition: {
				async close() {},
				async execute(input) {
					return {
						freshUntilMs: null,
						result: {
							provider: "llm-fetch@0.1.4",
							observedAt: new Date().toISOString(),
							cache: "bypass",
							hits:
								input.operation === "lookup"
									? [
											{
												url: "https://example.com/source",
												title: "一次資料",
												snippet: "検索候補",
												provider: "fixture",
												trust: "untrusted",
												tainted: true,
												verification: "search_summary",
											},
										]
									: [],
							documents:
								input.operation === "read"
									? [
											{
												url: input.url,
												title: "一次資料",
												text: "本文で確認した事実",
												fetchedAt: new Date().toISOString(),
												truncated: false,
												trust: "untrusted",
												tainted: true,
												verification: "source_read",
												guardDecision: "allow",
												guardReasonCodes: [],
											},
										]
									: [],
							failures: [],
						},
					};
				},
			},
		});
		try {
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: request,
			});
			await waitFor(() => h.dialogue.get(run.id)?.status === "completed");
			await waitFor(() => h.reported().includes('"document"'), {
				timeout: 10000,
			});
			const result = JSON.parse(h.reported());
			expect(result.status).toBe("completed");
			expect(result.document).toMatchObject({
				title: "一次資料の比較調査",
				local: { state: "saved" },
				archive: { state: online ? "saved" : "unsaved" },
			});
			const content = await h.request(
				`/api/scratch/${result.document.id}/content`,
			);
			expect(content.status).toBe(200);
			expect(await content.text()).toBe(result.answer);
			expect(scratch.get(result.document.id)?.name).toBe(
				"一次資料の比較調査.md",
			);
			const uri = `eumenes://markdown.document/generated-${result.document.id}`;
			const sourceUrl = `/api/toolchain-artifacts/${encodeURIComponent("artifact:markdown.workspace@4")}/sources/markdown-workspace?target=generated-${result.document.id}`;
			expect(result.links).toEqual([uri]);
			expect(await (await h.request("/api/todo-notices")).json()).toEqual({
				notices: [],
				unread: 0,
			});
			const resources = await (
				await h.request("/api/conversations/main/resources")
			).json();
			expect(resources.resources).toEqual([
				expect.objectContaining({ uri, kind: "markdown.document" }),
			]);
			expect(resources.messages).toEqual([
				{ messageId: run.inputMessageId, uris: [uri] },
			]);
			const resolve = (ref: string) =>
				h.request(`/api/resources/resolve?uri=${encodeURIComponent(ref)}`);
			expect(
				(await resolve(`eumenes://scratch/${result.document.id}`)).status,
			).toBe(404);
			expect(await (await resolve(uri)).json()).toMatchObject({
				ok: true,
				resource: {
					adapterRef: "adapter:markdown@1",
					targetRef: `generated-${result.document.id}`,
				},
			});
			const source = await (await h.request(sourceUrl)).json();
			expect(
				h.store.read((db) =>
					db
						.query("SELECT count(*) AS n FROM dialogue_specialist_sessions")
						.get(),
				),
			).toEqual({ n: 0 });
			if (online) {
				expect(puts).toBe(1);
				const remote = saved.get(result.document.archive.sourceId)!;
				expect(remote.markdown).toBe(result.answer);
				expect(remote.recovery).toBe("");
				expect(remote.entry.path).toBe("research/一次資料の比較調査.md");
				expect(source).toMatchObject({
					data: { openSourceId: remote.entry.sourceId, current: null },
				});
				const preview = await (
					await h.request(`/api/markdown/remote/${remote.entry.sourceId}`)
				).json();
				expect(preview).toMatchObject({
					markdown: result.answer,
					document: null,
				});
			} else {
				expect(puts).toBe(0);
				expect(source).toMatchObject({
					data: {
						current: null,
						preview: { title: result.document.title, markdown: result.answer },
					},
				});
			}
			const task = h.store.read((db) =>
				db.query("SELECT id FROM pursuit_runs").get(),
			) as { id: string };
			await h.store.write((db) =>
				h.toolchain.pursuit!.task.forgetInTransaction!(db, task.id),
			);
			expect(scratch.get(result.document.id)).toBeNull();
			expect((await resolve(uri)).status).toBe(404);
			expect(online ? saved.size : 0).toBe(online ? 1 : 0);
		} finally {
			await h.close();
			scratch.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);
}
