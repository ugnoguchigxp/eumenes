import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../client";
import { ScratchViewer } from "./ScratchViewer";

afterEach(cleanup);

const item = (mime: string, name: string) => ({
	id: "5b0c6f1e-0000-4000-8000-000000000001",
	uri: "eumenes://scratch/5b0c6f1e-0000-4000-8000-000000000001",
	conversationId: "main",
	name,
	mime,
	bytes: 2048,
	origin: "written",
	maker: "詳しいWeb調査",
	contentUrl: "/api/scratch/5b0c6f1e-0000-4000-8000-000000000001/content",
	createdAt: "2026-11-07T05:00:00.000Z",
	usedAt: "2026-11-07T05:00:00.000Z",
});
const client = (mime: string, name: string, body: string) =>
	({
		scratchItem: vi.fn(async () => item(mime, name)),
		scratchContent: vi.fn(async () => new Blob([body], { type: mime })),
	}) as unknown as EumenesClient;

test("a shared Markdown file is shown as it is written, with who made it", async () => {
	render(
		<ScratchViewer
			client={client("text/markdown", "価格表.md", "| 社名 | 月額 |")}
			id="5b0c6f1e-0000-4000-8000-000000000001"
			onClose={vi.fn()}
		/>,
	);
	expect(await screen.findByText("| 社名 | 月額 |")).toBeTruthy();
	expect(screen.getByText("価格表.md")).toBeTruthy();
	expect(screen.getByText(/詳しいWeb調査・2KB・サーバーの再起動で消えます/)).toBeTruthy();
});

test("a PDF is offered as a download; a file that is gone says so", async () => {
	URL.createObjectURL = vi.fn(() => "blob:pdf");
	URL.revokeObjectURL = vi.fn();
	const view = render(
		<ScratchViewer
			client={client("application/pdf", "資料.pdf", "%PDF")}
			id="5b0c6f1e-0000-4000-8000-000000000001"
			onClose={vi.fn()}
		/>,
	);
	const link = (await screen.findByText("ダウンロード")).closest("a")!;
	expect(link.getAttribute("download")).toBe("資料.pdf");
	view.unmount();
	render(
		<ScratchViewer
			client={
				{
					scratchItem: vi.fn(async () => {
						throw new Error("item_not_found");
					}),
					scratchContent: vi.fn(),
				} as unknown as EumenesClient
			}
			id="5b0c6f1e-0000-4000-8000-000000000002"
			onClose={vi.fn()}
		/>,
	);
	expect(await screen.findByRole("alert")).toBeTruthy();
});
