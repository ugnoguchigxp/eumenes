import { expect, test } from "@playwright/test";
import { createFixture } from "./fixture";

test.setTimeout(60000);
const fixture = createFixture();
let origin: string;
test.beforeAll(async () => {
	const [apiPort, webPort] = (await fixture.ports(2)) as [number, number];
	origin = `http://127.0.0.1:${webPort}`;
	await fixture.launch(
		["scripts/claude-code-fixture-server.ts"],
		{ EUMENES_PORT: String(apiPort), EUMENES_ORIGIN: origin },
		{ ports: [apiPort] },
	);
	await fixture.ready(`http://127.0.0.1:${apiPort}/api/status`);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-claude-code-vite-${webPort}`,
	});
	await fixture.ready(origin);
});
test.afterAll(() => fixture.stopAll());

const evidence = "spec/verification/claude-code-requests-2026-10-14";

async function ask(page: import("@playwright/test").Page, text: string) {
	await page.getByRole("textbox").first().fill(text);
	await page.getByRole("button", { name: "送信", exact: true }).click();
}

test("a conversation request opens Claude Code, and the finished task is reported by name", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1500, height: 950 });
	await page.goto(origin);
	// Chat messages only (the live region repeats the latest one for screen readers).
	const said = (text: string) => page.locator("p").filter({ hasText: text });
	const streams: string[] = [];
	page.on("request", (r) => {
		if (/\/api\/terminals\/[^/]+\/output$/.test(r.url())) streams.push(r.url());
	});

	// Not open yet: the conversation's hand-over opens it.
	await expect(page.getByRole("tab", { name: "Claude Code" })).toHaveCount(0);
	await ask(page, "Claude Code で README の手順を直して");
	await expect(page.getByRole("tab", { name: "Claude Code" })).toBeVisible();
	await expect(said("承知しました。終わったらお知らせします。")).toBeVisible();
	const pane = page.locator(".terminal-pane");
	await expect(pane).toHaveCount(1);
	await expect.poll(() => streams.length).toBeGreaterThan(0);
	await page.waitForTimeout(500);
	await page.screenshot({ path: `${evidence}/conversation-started.png` });

	// When the task finishes, the agent reports it by name and suggests the next step. The
	// notice that asked for the report is not shown as a message.
	await expect(
		said("README の手順修正が終わりました。変更をコミットしますか？"),
	).toBeVisible();
	await expect(page.getByText("【通知】")).toHaveCount(0);
	await page.screenshot({ path: `${evidence}/conversation-reported.png` });

	// A follow-up is typed into the same session, shown in the same pane.
	await ask(page, "続けてテストも直して");
	await expect(said("承知しました。終わったらお知らせします。")).toHaveCount(2);
	await expect(
		said("README の手順修正が終わりました。変更をコミットしますか？"),
	).toHaveCount(2);
	await expect(pane).toHaveCount(1);
	await page.screenshot({ path: `${evidence}/conversation-followup.png` });
});
