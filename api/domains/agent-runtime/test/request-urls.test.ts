import { expect, test } from "bun:test";
import { requestUrls } from "../service/request-urls";
import { harness } from "./route-harness";

for (const url of [
	"https://example.org/日本語",
	"https://例え.jp/資料?q=天気",
	"https://example.org/%E6%97%A5%E6%9C%AC%E8%AA%9E",
]) {
	test(`explicit URL identity survives extraction and the shared invocation scope: ${url}`, async () => {
		expect(requestUrls(`このページ（${url}）を確認`)).toEqual([
			new URL(url).href,
		]);
		const h = await harness(Date.now, false, undefined, true);
		try {
			await h.start("unicode", `このページ（${url}）を確認`);
			const id = h.agents.list("unicode").find((t) => t.kind === "worker")!.id;
			await h.runRawModelStep(id, {
				action: "invoke",
				tool: "web.read",
				arguments: { url },
			});
			expect(h.task(id).state).toBe("waiting_tool");
			expect(h.started[0]?.args).toEqual({ url });
		} finally {
			await h.close();
		}
	});
}

test("a different path on the same host remains outside the request scope", async () => {
	const h = await harness(Date.now, false, undefined, true);
	try {
		await h.start("wrong-path", "確認 https://example.org/日本語");
		const id = h.agents.list("wrong-path").find((t) => t.kind === "worker")!.id;
		await h.runRawModelStep(id, {
			action: "invoke",
			tool: "web.read",
			arguments: { url: "https://example.org/" },
		});
		expect(h.task(id).error_code).toBe("tool_url_out_of_scope");
		expect(h.started).toHaveLength(0);
	} finally {
		await h.close();
	}
});
