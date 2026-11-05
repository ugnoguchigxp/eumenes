import { writeFile } from "node:fs/promises";
import { join } from "node:path";
/** The pinned MCP CLI's memory-only Chromium configuration; never an extension/user profile. */
export async function prepareMcpIsolation(
	directory: string,
	executablePath: string | undefined,
) {
	await writeFile(
		join(directory, "isolation.json"),
		JSON.stringify({
			browser: {
				browserName: "chromium",
				isolated: true,
				launchOptions: {
					executablePath,
					headless: true,
					args: [
						"--mute-audio",
						"--disable-quic",
						"--webrtc-ip-handling-policy=disable_non_proxied_udp",
					],
				},
				contextOptions: { acceptDownloads: false, serviceWorkers: "block" },
			},
		}),
		{ mode: 0o600 },
	);
}
