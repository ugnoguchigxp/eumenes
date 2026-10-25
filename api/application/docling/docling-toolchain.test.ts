import { expect, test } from "bun:test";
import { createDocling } from "../../domains/docling";
import { harness } from "../toolchain/toolchain.fixture";

test("registered Docling chain runs its profile/Skill/tool and returns one launcher without connecting upstream", async () => {
	let posts = 0;
	const docling = createDocling({
		connection: () => null,
		status: () => ({
			revision: 1,
			configured: true,
			publicOrigin: "http://localhost:28765",
		}),
		fetch: (async () => {
			posts++;
			throw new Error("not_expected");
		}) as import("../../domains/docling").DoclingFetch,
	});
	const h = await harness({
		docling,
		routeTool: "docling_desk",
		command: () =>
			JSON.stringify({ action: "invoke", tool: "docling.open", arguments: {} }),
	});
	try {
		const entries = (await (await h.request("/api/toolchain-artifacts")).json())
			.artifacts as Array<{ artifactId: string }>;
		expect(
			entries.filter((entry) => entry.artifactId === "docling.workspace"),
		).toHaveLength(1);
		const source = await h.request(
			`/api/toolchain-artifacts/${encodeURIComponent("artifact:docling.workspace@1")}/sources/docling-launcher`,
		);
		expect(source.status).toBe(200);
		expect((await source.json()).data.configured).toBe(true);
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "Docling Deskを開いて",
		});
		const done = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 10000 });
		expect(done?.status).toBe("completed");
		expect(h.commandContexts.join("\n")).toContain("別タブ");
		expect(h.commandContexts.join("\n")).toContain(
			"文書の取り込み、OCR、変換を実行したとは説明しない",
		);
		expect(h.reported()).toContain("ready_for_open");
		expect(posts).toBe(0);
		await h.toolchain.capabilities.seed();
		expect(
			(
				await (await h.request("/api/toolchain-artifacts")).json()
			).artifacts.filter(
				(entry: { artifactId: string }) =>
					entry.artifactId === "docling.workspace",
			),
		).toHaveLength(1);
	} finally {
		await h.close();
	}
});
