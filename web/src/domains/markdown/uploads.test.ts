import { expect, test, vi } from "vitest";
import { markdownUploads } from "./uploads";
import type { EumenesClient } from "../../../../client";
function fixture(conversationId: string | undefined = "main") {
	const client = {
		uploadScratchFile: vi.fn(async () => ({
			uri: "eumenes://scratch/cache-id",
		})),
		markdownStage: vi.fn(async () => ({ id: "stage" })),
	};
	return {
		client,
		upload: markdownUploads(client as unknown as EumenesClient, conversationId),
	};
}
test("automatic cache uses the existing SSD upload and the same request id without staging or Docling calls", async () => {
	const h = fixture(),
		file = new File(['{"markdown":"原文\\r\\n"}'], "一時文書.json", {
			type: "application/json",
		}),
		requestId = crypto.randomUUID();
	expect(
		await h.upload("markdown-workspace", file, {
			purpose: "markdown-cache",
			requestId,
		}),
	).toMatchObject({ status: "accepted", value: "eumenes://scratch/cache-id" });
	expect(h.client.uploadScratchFile).toHaveBeenCalledWith(
		"main",
		requestId,
		file,
	);
	expect(h.client.markdownStage).not.toHaveBeenCalled();
});
test("a cache failure is rejected without another storage destination or automatic resend", async () => {
	const h = fixture();
	h.client.uploadScratchFile.mockRejectedValueOnce(
		new Error("scratch_capacity"),
	);
	expect(
		await h.upload("markdown-workspace", new File(["{}"], "文書.json"), {
			purpose: "markdown-cache",
			requestId: crypto.randomUUID(),
		}),
	).toMatchObject({ status: "rejected" });
	expect(h.client.uploadScratchFile).toHaveBeenCalledTimes(1);
	expect(h.client.markdownStage).not.toHaveBeenCalled();
});
test("an invalid cache request never writes", async () => {
	const h = fixture();
	expect(
		await h.upload("markdown-workspace", new File(["{}"], "文書.json"), {
			purpose: "markdown-cache",
			requestId: "invalid",
		}),
	).toMatchObject({ status: "rejected" });
	expect(h.client.uploadScratchFile).not.toHaveBeenCalled();
});
