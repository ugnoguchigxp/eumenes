import { expect, test } from "@playwright/test";
import { createFixture } from "./fixture";
import { openFromLauncher, closeArtifact } from "./artifact-launcher";

const fixture = createFixture();
let origin: string;
test.setTimeout(60_000);
test.beforeAll(async () => {
	const [apiPort, webPort] = (await fixture.ports(2)) as [number, number];
	origin = `http://127.0.0.1:${webPort}`;
	await fixture.launch(
		["scripts/cli-fixture-server.ts"],
		{ EUMENES_PORT: String(apiPort), EUMENES_ORIGIN: origin },
		{ ports: [apiPort] },
	);
	await fixture.ready(`http://127.0.0.1:${apiPort}/api/status`);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-cli-vite-${webPort}`,
	});
	await fixture.ready(origin);
});
test.afterAll(() => fixture.stopAll());

test("CLI opens from the launcher, reconnects to the same shell and shows conversation executions", async ({
	page,
}) => {
	await page.goto(origin);
	await openFromLauncher(page, "CLI");
	await expect(
		page.getByRole("tab", { name: "CLI", exact: true }),
	).toBeVisible();
	await expect(page.locator(".terminal-pane")).toHaveCount(1);
	const sessions = async () => {
		const r = await page.request.get(`${origin}/api/shell/sessions`, {
			headers: { authorization: "Bearer fixture-token-for-toolchain-browser" },
		});
		return r.json();
	};
	const first = await sessions();
	const id = first.sessions.find(
		(s: { kind: string }) => s.kind === "shell",
	).id;
	await page.locator(".xterm-helper-textarea").first().focus();
	await page.keyboard.type("printf 'manual-cli\\n'");
	await page.keyboard.press("Enter");
	await closeArtifact(page, "CLI");
	await openFromLauncher(page, "CLI");
	expect(
		(await sessions()).sessions.find(
			(s: { kind: string }) => s.kind === "shell",
		).id,
	).toBe(id);
	await page.getByRole("textbox").first().fill("CLIで端末の動作を確認して");
	await page.getByRole("button", { name: "送信", exact: true }).click();
	await expect(page.locator(".terminal-pane")).toHaveCount(2);
	await expect(page.getByText("終了コード 0", { exact: true })).toBeVisible();
	await expect(
		page
			.locator("p")
			.filter({ hasText: "CLI fixture output と表示されました" }),
	).toBeVisible();
	await page.setViewportSize({ width: 420, height: 900 });
	await expect(page.locator(".terminal-workspace")).toBeVisible();
});
