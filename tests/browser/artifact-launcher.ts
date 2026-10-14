import { expect, type Page } from "@playwright/test";

/** Opens an artifact from the top-right launcher; saved items do not open on page load. */
export async function openFromLauncher(page: Page, label: string) {
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page.getByRole("menuitem", { name: label, exact: true }).click();
}

/** Opens the settings artifact and, when given, one of its hub screens. */
export async function openSettings(page: Page, screen?: string) {
	await openFromLauncher(page, "設定");
	if (screen)
		await page.getByRole("button", { name: screen, exact: true }).click();
}

/** Saves the settings draft and waits for the applied notice. */
export async function saveSettings(page: Page) {
	await page
		.getByRole("button", { name: "設定の変更をすべて保存", exact: true })
		.click();
	await expect(
		page.getByRole("status").filter({ hasText: "変更を適用しました" }).first(),
	).toBeVisible();
}

/** Closes the active artifact tab so the conversation fills the screen again. */
export async function closeArtifact(page: Page, title: string) {
	await page.getByRole("button", { name: `${title}を閉じる` }).click();
}
