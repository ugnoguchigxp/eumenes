import { test, expect, type Page } from "@playwright/test";
import { createFixture } from "./fixture";

const TOKEN = "fixture-token-for-toolchain-browser";
const TITLE = "設定（データドリブン）";

test.setTimeout(90000);
let apiPort: number, webPort: number;
const fixture = createFixture();
const auth = { authorization: `Bearer ${TOKEN}` };

test.beforeAll(async () => {
	apiPort = await fixture.port();
	webPort = await fixture.port();
	await fixture.launch(
		["scripts/settings-fixture-server.ts"],
		{
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		},
		{ ports: [apiPort] },
	);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: TOKEN,
		cacheDir: `/tmp/eumenes-settings-p3-vite-${webPort}`,
	});
	await fixture.waitUntil(
		async () => {
			const web = await fetch(`http://127.0.0.1:${webPort}`);
			const api = await fetch(`http://127.0.0.1:${apiPort}/api/settings`, {
				headers: auth,
			});
			return web.ok && api.ok;
		},
		{ message: "fixture_not_ready" },
	);
});

test.afterAll(async () => {
	await fixture.stopAll();
});

async function openHub(page: Page) {
	await page.goto(`http://127.0.0.1:${webPort}`);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page.getByRole("menuitem", { name: TITLE, exact: true }).click();
	await expect(page.getByRole("button", { name: "会話" })).toBeVisible();
}

/** From the hub, opens one registered screen in its own tab. */
async function openFromHub(page: Page, label: string) {
	await page.getByRole("button", { name: label, exact: true }).click();
	await expect(
		page
			.getByRole("tablist", { name: "アーティファクトのタブ" })
			.getByRole("tab", { selected: true }),
	).not.toHaveText(TITLE);
}

test("dump", async ({ page }) => {
	await openHub(page);
	
	for (const l of ["読み方辞書", "記憶", "World", "Codexへの委任", "動作確認"]) {
		await page.getByRole("tab", { name: TITLE }).first().click();
		await openFromHub(page, l);
		await page.waitForTimeout(1500);
		console.log("SCREEN", l, await page.getByRole("tabpanel").evaluateAll((els) => els.filter((e) => e.checkVisibility()).map((e) => e.innerText).join("\n----\n")));
	}
});
