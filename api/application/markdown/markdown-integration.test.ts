import { expect, test } from "bun:test";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";
import type { ArchivePort } from "../../domains/markdown";
const archive: ArchivePort = {
	available: () => true,
	binding: () => "fixture",
	list: async () => [],
	read: async () => {
		throw new Error("unused");
	},
	save: async (input) => ({
		sourceId: "desk-source",
		documentId: input.documentId,
		title: input.title,
		revision: "desk-r1",
		path: `${input.documentId}.md`,
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
			"/api/toolchain-artifacts/artifact:markdown.workspace@1/sources/markdown-workspace?params=" +
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
			await h.request("/api/toolchain-artifacts/artifact:markdown.workspace@1")
		).json();
		const event = {
			version: 1,
			eventId: crypto.randomUUID(),
			eventCreatedAt: new Date().toISOString(),
			eventExpiresAt: new Date(Date.now() + 60000).toISOString(),
			artifactId: "fixture-tab",
			artifactRevisionId: "artifact:markdown.workspace@1",
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
			sourceId: "desk-source",
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
