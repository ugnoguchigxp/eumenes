import { expect, test } from "bun:test";
import { createDocling } from "../../domains/docling";
import { assignmentFixture } from "../toolchain/assignment.fixture";

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
	const f = await assignmentFixture({
		docling,
		command: () =>
			JSON.stringify({ action: "invoke", tool: "docling.open", arguments: {} }),
	});
	const { h } = f;
	try {
		const entries = (await (await h.request("/api/toolchain-artifacts")).json())
			.artifacts as Array<{ artifactId: string; title: string }>;
		expect(
			entries.filter((entry) => entry.artifactId === "docling.workspace"),
		).toHaveLength(1);
		expect(
			entries.find((entry) => entry.artifactId === "docling.workspace")?.title,
		).toBe("文章ナレッジベース管理");
		const source = await h.request(
			`/api/toolchain-artifacts/${encodeURIComponent("artifact:docling.workspace@2")}/sources/docling-launcher`,
		);
		expect(source.status).toBe(200);
		expect((await source.json()).data.configured).toBe(true);
		const { result } = await f.assign("Docling Deskを開いて", "docling.desk");
		expect(result).toMatchObject({ status: "accepted" });
		await f.settled();
		expect(f.executions()).toMatchObject([{ status: "completed" }]);
		expect(h.commandContexts.join("\n")).toContain("別タブ");
		expect(h.commandContexts.join("\n")).toContain(
			"文書の取り込み、OCR、変換を実行したとは説明しない",
		);
		expect(f.reported()).toContain("ready_for_open");
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
		await f.close();
	}
});
