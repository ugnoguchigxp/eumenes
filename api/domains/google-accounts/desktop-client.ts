import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Release packaging supplies this file; credentials never belong in the source repository.
const distributionFile = fileURLToPath(
	new URL("./distribution-client.json", import.meta.url),
);
const desktopClient = z.object({
	installed: z.object({
		client_id: z.string().trim().min(1).max(512),
		client_secret: z.string().trim().min(1).max(512).optional(),
	}),
	web: z.never().optional(),
});
export function loadDesktopClient(
	env: Record<string, string | undefined>,
	bundledFile = distributionFile,
) {
	const override = env.EUMENES_GOOGLE_DESKTOP_CLIENT_FILE?.trim();
	let text: string;
	try {
		text = readFileSync(override || bundledFile, "utf8");
	} catch (error) {
		if (!override && (error as NodeJS.ErrnoException).code === "ENOENT")
			return undefined;
		throw new Error("config_invalid:EUMENES_GOOGLE_DESKTOP_CLIENT_FILE");
	}
	try {
		const { installed } = desktopClient.parse(JSON.parse(text));
		return {
			clientId: installed.client_id,
			clientSecret: installed.client_secret,
		};
	} catch {
		// Zod and JSON parsing errors may contain client credentials; expose only a fixed code.
		throw new Error("config_invalid:EUMENES_GOOGLE_DESKTOP_CLIENT_FILE");
	}
}

/** Reuse the local Web listener and its browser-bound callback; no shared auth server. */
export function desktopRedirectUri(origin: string): string {
	try {
		const url = new URL(origin);
		if (
			url.protocol !== "http:" ||
			!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			throw new Error();
		return new URL("/oauth/google/callback", url).href;
	} catch {
		throw new Error("config_invalid:EUMENES_ORIGIN");
	}
}
