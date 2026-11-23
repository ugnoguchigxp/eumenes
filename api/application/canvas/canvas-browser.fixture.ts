import type { Browser } from "@playwright/test";
import { ObservationBrowser } from "eumenes-canvas/src/core/harness-session";
import { canvasFile } from "./runtime";

/** HTTP待受を作らず、実Chromiumの要求を同じ配信関数へ渡す。 */
export function routeObservationBrowser(
	fetch: (request: Request) => Promise<Response>,
) {
	const original = ObservationBrowser.prototype.get;
	const wrapped = new WeakSet<Browser>();
	ObservationBrowser.prototype.get = async function () {
		const browser = await original.call(this);
		if (!wrapped.has(browser)) {
			wrapped.add(browser);
			const create = browser.newContext.bind(browser);
			browser.newContext = async (...args) => {
				const context = await create(...args);
				await context.route("**/*", async (route) => {
					const request = route.request();
					const response = await fetch(
						new Request(request.url(), {
							method: request.method(),
							headers: await request.allHeaders(),
							body: request.postData() ?? undefined,
						}),
					);
					await route.fulfill({
						status: response.status,
						headers: Object.fromEntries(response.headers),
						body: Buffer.from(await response.arrayBuffer()),
					});
				});
				return context;
			};
		}
		return browser;
	};
	return () => {
		ObservationBrowser.prototype.get = original;
	};
}

const harnessFiles: Record<string, [string, string]> = {
	"/harness.html": ["src/host/harness.html", "text/html"],
	"/harness.js": ["src/host/harness.js", "text/javascript"],
	"/harness.css": ["src/host/harness.css", "text/css"],
	"/preview-client.js": ["src/host/preview-client.js", "text/javascript"],
	"/shared/messages.js": ["src/shared/messages.js", "text/javascript"],
};
export function canvasHarness(
	request: Request,
	hostOrigin: string,
	previewOrigin: string,
) {
	const path = new URL(request.url).pathname;
	if (path === "/api/config")
		return Response.json({ hostOrigin, previewOrigin });
	const file = harnessFiles[path];
	return file
		? new Response(canvasFile(file[0]), {
				headers: {
					"content-type": file[1],
					"cache-control": "no-store",
					"content-security-policy": `default-src 'self'; frame-src ${previewOrigin}; frame-ancestors 'none'`,
				},
			})
		: null;
}
