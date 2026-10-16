import { expect, type Locator } from "@playwright/test";

/**
 * A screenshot of a canvas once rendering has settled: two consecutive captures
 * are identical. Replaces fixed sleeps before a picture is taken or compared.
 */
export async function settledScreenshot(
	canvas: Locator,
	options: { path?: string; timeout?: number } = {},
): Promise<Buffer> {
	let previous: Buffer | undefined;
	await expect
		.poll(
			async () => {
				const current = await canvas.screenshot();
				const same = previous?.equals(current) ?? false;
				previous = current;
				return same;
			},
			{ timeout: options.timeout ?? 15_000, intervals: [100, 250, 500] },
		)
		.toBe(true);
	return canvas.screenshot({ path: options.path });
}
