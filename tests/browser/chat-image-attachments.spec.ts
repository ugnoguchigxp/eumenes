import { test, expect } from "@playwright/test";
import { createFixture } from "./fixture";
import { syntheticImages } from "../../api/domains/conversation/test/image.fixture";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test.setTimeout(60000);
const fixture = createFixture();
let origin: string;
let webDir: string;
test.beforeAll(async () => {
	const [apiPort, webPort] = (await fixture.ports(2)) as [number, number];
	origin = `http://127.0.0.1:${webPort}`;
	await fixture.launch(
		["scripts/chat-image-fixture-server.ts"],
		{ EUMENES_PORT: String(apiPort), EUMENES_ORIGIN: origin },
		{ ports: [apiPort] },
	);
	await fixture.ready(`http://127.0.0.1:${apiPort}/api/status`);
	// Test an immutable production bundle: concurrent repository edits must not HMR-reload a draft.
	webDir = mkdtempSync(join(tmpdir(), "eumenes-chat-images-web-"));
	cpSync("dist-web", webDir, { recursive: true });
	await fixture.launch(
		["scripts/chat-image-browser-server.ts"],
		{
			EUMENES_PORT: String(webPort),
			EUMENES_WEB_DIR: webDir,
			EUMENES_PROXY_URL: `http://127.0.0.1:${apiPort}`,
		},
		{ ports: [webPort] },
	);
	await fixture.ready(origin);
});
test.afterAll(async () => {
	await fixture.stopAll();
	if (webDir) rmSync(webDir, { recursive: true, force: true });
});

test("full chat paste and drop, picker, thumbnail removal, image-only send, reload and past-image resend", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(origin);
	const input = page.getByRole("textbox", { name: "メッセージ", exact: true });
	const files = await syntheticImages();
	const png = files[1]!;
	const raw = [...new Uint8Array(await png.arrayBuffer())];
	await input.fill("前後");
	await input.focus();
	await input.evaluate((el: HTMLTextAreaElement, raw) => {
		el.setSelectionRange(1, 1);
		const data = new DataTransfer();
		data.items.add(
			new File([new Uint8Array(raw)], "pasted.png", { type: "image/png" }),
		);
		data.setData("text/plain", "追加");
		el.dispatchEvent(
			new ClipboardEvent("paste", {
				clipboardData: data,
				bubbles: true,
				cancelable: true,
			}),
		);
	}, raw);
	await expect(input).toHaveValue("前追加後");
	await expect(page.locator(".draft-image")).toHaveCount(1);
	await page.getByRole("button", { name: "pasted.pngの添付を外す" }).click();
	await expect(page.locator(".draft-image")).toHaveCount(0);
	await page.locator(".chat-history").evaluate((el, raw) => {
		const data = new DataTransfer();
		data.items.add(
			new File([new Uint8Array(raw)], "dropped.png", { type: "image/png" }),
		);
		el.dispatchEvent(
			new DragEvent("drop", {
				dataTransfer: data,
				bubbles: true,
				cancelable: true,
			}),
		);
	}, raw);
	await expect(page.locator(".draft-image")).toHaveCount(1);
	await page.getByRole("button", { name: "dropped.pngの添付を外す" }).click();
	await page.getByLabel("添付画像を選択").setInputFiles(
		await Promise.all(
			files.map(async (f) => ({
				name: f.name,
				mimeType: f.type,
				buffer: Buffer.from(await f.arrayBuffer()),
			})),
		),
	);
	await input.fill("");
	await expect(
		page.getByText(/LARMの推論監査に画像が保存されます/),
	).toBeVisible();
	await expect(page.locator(".draft-image")).toHaveCount(3);
	await page.getByRole("button", { name: "red.pngを確認" }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "送信", exact: true }).click();
	await expect(page.locator(".message-images img")).toHaveCount(3);
	await expect(page.locator(".draft-image")).toHaveCount(0);
	await expect(page.locator(".message-assistant").last()).toContainText(
		"画像を確認しました。",
	);
	await page.reload();
	await expect(page.locator(".message-images img")).toHaveCount(3);
	for (const img of await page.locator(".message-images img").all())
		await expect(img).toHaveJSProperty("naturalWidth", 24);
	await input.fill("先ほどの画像を比較して");
	await page.getByRole("button", { name: "送信", exact: true }).click();
	await expect(page.locator(".message-assistant")).toHaveCount(2);
	const requests = await page.evaluate(async () =>
		(await fetch("/api/chat-image-fixture/requests")).json(),
	);
	const generated = requests.filter(
		(r: { operation: string }) => r.operation === "generate",
	);
	expect(generated).toHaveLength(2);
	for (const r of generated)
		expect(
			r.body.messages.flatMap((m: { content: unknown }) =>
				Array.isArray(m.content)
					? m.content.filter((p: { type: string }) => p.type === "image_url")
					: [],
			),
		).toHaveLength(3);
	await page.setViewportSize({ width: 390, height: 844 });
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	mkdirSync("spec/verification/chat-image-attachments-2026-10-13", {
		recursive: true,
	});
	await page.screenshot({
		path: "spec/verification/chat-image-attachments-2026-10-13/chat-narrow.png",
		fullPage: true,
	});
	await expect(page.getByRole("alert")).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("bad upload preserves draft and attachment, unsupported files and count limits explain rejection", async ({
	page,
}) => {
	await page.goto(origin);
	const input = page.getByRole("textbox", { name: "メッセージ", exact: true });
	await input.fill("保持する本文");
	await page.getByLabel("添付画像を選択").setInputFiles({
		name: "broken.png",
		mimeType: "image/png",
		buffer: Buffer.from("broken"),
	});
	await page.getByRole("button", { name: "送信", exact: true }).click();
	await expect(
		page.getByRole("alert").filter({ hasText: "画像を読み取れません" }),
	).toBeVisible();
	await expect(input).toHaveValue("保持する本文");
	await expect(page.locator(".draft-image")).toHaveCount(1);
	await page.getByRole("button", { name: "broken.pngの添付を外す" }).click();
	await page.getByLabel("添付画像を選択").setInputFiles({
		name: "bad.gif",
		mimeType: "image/gif",
		buffer: Buffer.from("GIF89a"),
	});
	await expect(
		page.getByRole("alert").filter({ hasText: "JPG・PNG・BMP" }),
	).toBeVisible();
	const f = (await syntheticImages())[1]!;
	await page.getByLabel("添付画像を選択").setInputFiles(
		Array.from({ length: 9 }, (_, i) => ({
			name: `${i}.png`,
			mimeType: "image/png",
			buffer: Buffer.alloc(1),
		})),
	);
	await expect(
		page.getByRole("alert").filter({ hasText: "8枚まで" }),
	).toBeVisible();
	await page.getByLabel("添付画像を選択").setInputFiles({
		name: f.name,
		mimeType: f.type,
		buffer: Buffer.from(await f.arrayBuffer()),
	});
	await expect(page.locator(".draft-image")).toHaveCount(1);
});
