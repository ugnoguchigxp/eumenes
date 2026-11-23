import { expect, test } from "@playwright/test";
import { createFixture } from "./fixture";
import { openFromLauncher } from "./artifact-launcher";

test.use({ launchOptions: { args: ["--mute-audio"] } });
test.setTimeout(90000);
const fixture = createFixture();
let origin: string, api: string;
async function requireFixture() {
	const response = await fetch(`${api}/__fixture/app-development`);
	if (!response.ok || (await response.json()).fixture !== "app-development")
		throw new Error("app_development_fixture_required");
}
test.beforeAll(async () => {
	if (
		process.env.EUMENES_APP_FIXTURE_ORIGIN &&
		process.env.EUMENES_APP_FIXTURE_API
	) {
		origin = process.env.EUMENES_APP_FIXTURE_ORIGIN;
		api = process.env.EUMENES_APP_FIXTURE_API;
		await fixture.ready(`${api}/api/status`);
		await requireFixture();
		await fixture.ready(origin);
		return;
	}
	const [apiPort, webPort] = await fixture.ports(2);
	origin = `http://127.0.0.1:${webPort}`;
	api = `http://127.0.0.1:${apiPort}`;
	await fixture.launch(
		["scripts/app-development-fixture-server.ts"],
		{ EUMENES_PORT: String(apiPort), EUMENES_ORIGIN: origin },
		{ ports: [apiPort!] },
	);
	await fixture.ready(`${api}/api/status`);
	await requireFixture();
	await fixture.launchWeb({
		webPort: webPort!,
		apiPort: apiPort!,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-app-vite-${webPort}`,
	});
	await fixture.ready(origin);
});
test.afterAll(() => fixture.stopAll());

test("conversation → failed save → retry → draft recovery → record edit → reopen", async ({
	page,
}) => {
	await page.goto(origin);
	const conversation = page.getByRole("region", { name: "会話" });
	await conversation
		.getByRole("textbox", { name: "メッセージ" })
		.fill(
			"読んだ本の題名と感想を記録し、後から感想を編集できるアプリを作ってください",
		);
	await conversation.getByRole("button", { name: "送信", exact: true }).click();
	const studio = page.locator(".aui-ui-studio");
	await expect(studio).toBeVisible();
	await studio
		.getByRole("button", { name: "確認して保存", exact: true })
		.click();
	await expect(
		studio.getByText("保存先の準備に失敗しました。", { exact: false }),
	).toBeVisible();
	await expect(
		studio.getByRole("button", { name: "下書きに戻す", exact: true }),
	).toBeVisible();
	await page.request.post(`${api}/__fixture/release-storage`);
	await page.request.post(`${api}/__fixture/fail-next-publication`);
	await studio
		.getByRole("button", { name: "保存を再試行", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(
					await (
						await page.request.get(`${api}/__fixture/app-development`)
					).json()
				).publicationFailures,
		)
		.toBe(1);
	await studio
		.getByRole("button", { name: "下書きに戻す", exact: true })
		.click();
	await expect(
		studio.getByRole("button", { name: "確認して保存", exact: true }),
	).toBeEnabled();
	await studio
		.getByRole("button", { name: "確認して保存", exact: true })
		.click();
	await expect(
		studio.getByRole("button", { name: "記録を追加", exact: true }),
	).toBeVisible();
	await studio
		.getByRole("textbox", { name: "題名", exact: true })
		.fill("検証用の本");
	await studio
		.getByRole("textbox", { name: "感想", exact: true })
		.fill("最初の感想");
	await studio.getByRole("button", { name: "記録を追加", exact: true }).click();
	const records = studio.getByRole("region", { name: "保存した記録" });
	await expect(records).toContainText("最初の感想");
	await records.getByRole("button", { name: "編集", exact: true }).click();
	await studio
		.getByRole("textbox", { name: "感想", exact: true })
		.fill("変更した感想");
	await studio.getByRole("button", { name: "変更を保存", exact: true }).click();
	await expect(records).toContainText("変更した感想");
	await page.reload();
	await openFromLauncher(page, "Webアプリ開発");
	await page.getByRole("button", { name: "作品履歴", exact: true }).click();
	await page.getByRole("button", { name: "読書メモ", exact: true }).click();
	await expect(
		page.getByRole("region", { name: "保存した記録" }),
	).toContainText("変更した感想");
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(
		page.getByRole("button", { name: "記録を追加", exact: true }),
	).toBeVisible();
});
