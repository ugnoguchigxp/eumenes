// P0 Chromium probe. The optional listener is ephemeral, IPv4 loopback only.
import { createConnection } from "node:net";
import { expect, chromium } from "@playwright/test";

const useListener = process.argv.includes("--loopback");
const useChrome = process.argv.includes("--chrome");
const observeStall = process.argv.includes("--observe-stall");
const forceSiteIsolation = !useListener || process.argv.includes("--force-site-isolation");
const document = (contents: string) => `<!doctype html><meta charset="utf-8">${contents}`;
const loopback = "127.0.0.1";
const seenHosts = new Set<string>();
const attemptedCoreApi: string[] = [];
const workerRequests: string[] = [];
let port = 18421;

const origins = () => ({
	core: `http://localhost:${port}`,
	first: `http://p-a.localhost:${port}`,
	second: `http://p-b.localhost:${port}`,
});

function text(body: string, contentType: string, csp?: string) {
	const headers = new Headers({ "content-type": contentType, "cache-control": "no-store" });
	if (csp) headers.set("content-security-policy", csp);
	return new Response(body, { headers });
}

function fixture(request: Request, virtual = false): Response {
	const { core, first, second } = origins();
	const { origin, pathname, host } = new URL(request.url);
	if (!virtual && request.headers.get("host") !== host)
		return new Response(null, { status: 421 });
	if (![core, first, second].includes(origin))
		return new Response(null, { status: 421 });
	if (request.method !== "GET")
		return new Response(null, { status: 405 });
	seenHosts.add(host);

	const csp = [
		"default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
		"img-src 'self' blob:", "worker-src 'none'", `frame-ancestors ${core}`,
	].join("; ");
	if (origin === core && pathname === "/") {
		return text(document(`<button id="stop">Stop A</button><button id="share">Share A</button>
			<iframe id="a" sandbox="allow-scripts allow-same-origin" src="${first}/"></iframe>
			<iframe id="b" sandbox="allow-scripts allow-same-origin" src="${second}/"></iframe>
			<script src="/panel.js"></script>`), "text/html",
			`default-src 'none'; script-src 'self'; frame-src ${first} ${second}`);
	}
	if (origin === core && pathname === "/panel.js") {
		return text(`document.querySelector('#stop').onclick = () => document.querySelector('#a')?.remove();
			document.querySelector('#share').onclick = () => {
				const {port1, port2} = new MessageChannel();
				document.querySelector('#a').contentWindow.postMessage("fixture-asset", ${JSON.stringify(first)}, [port2]);
				const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';
				const bytes = new TextEncoder().encode(svg).buffer;
				port1.postMessage(bytes, [bytes]);
				port1.close();
			};`, "text/javascript");
	}
	if (origin === core && pathname.startsWith("/api/")) {
		attemptedCoreApi.push(pathname);
		return new Response(null, { status: 403 });
	}
	if (origin === first || origin === second) {
		if (pathname === "/") {
			const label = origin === first ? "A" : "B";
			return text(document(`<link rel="stylesheet" href="/assets/fixture.css">
				<p id="screen">ready</p><output id="asset"></output>
				<span id="identity">${label}</span><script src="/work.js"></script>`), "text/html", csp);
		}
		if (pathname === "/work.js") {
			return text(`addEventListener("message", (event) => {
				if (event.source !== parent || event.origin !== ${JSON.stringify(core)} || event.data !== "fixture-asset") return;
				event.ports[0].onmessage = async ({data}) => {
					const url = URL.createObjectURL(new Blob([data], {type: "image/svg+xml"}));
					try {
						const image = new Image();
						image.src = url;
						await image.decode();
						document.querySelector("#asset").textContent = String(image.naturalWidth);
					} finally {
						URL.revokeObjectURL(url);
						event.ports[0].close();
					}
				};
			});`, "text/javascript");
		}
		if (pathname === "/sw.js") {
			workerRequests.push(origin);
			return text("self.addEventListener('install', () => {});", "text/javascript");
		}
		if (pathname === "/assets/fixture.css")
			return text("#screen { color: rgb(23, 119, 96); }", "text/css");
		if (pathname === "/assets/fixture.json") return Response.json({ local: true });
	}
	return new Response(null, { status: 404 });
}

const listener = useListener ? Bun.serve({
	hostname: loopback,
	port: 0,
	fetch(request, server) {
		if (server.requestIP(request)?.address !== loopback)
			return new Response(null, { status: 403 });
		return fixture(request);
	},
}) : undefined;
if (listener?.port) port = listener.port;
const { core, first, second } = origins();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let outcome: Record<string, unknown> | undefined;

try {
	browser = await chromium.launch({
		channel: useChrome ? "chrome" : undefined,
		args: ["--mute-audio", "--no-proxy-server", ...(forceSiteIsolation ? ["--site-per-process"] : [])],
	});
	const context = await browser.newContext();
	if (!listener) {
		await context.route("**/*", async (route) => {
			const response = fixture(new Request(route.request().url(), { method: route.request().method() }), true);
			await route.fulfill({
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body: await response.text(),
			});
		});
	}

	const page = await context.newPage();
	await page.goto(core);
	await expect(page.frameLocator("#a").locator("#screen")).toHaveText("ready");
	await expect(page.frameLocator("#b").locator("#screen")).toHaveText("ready");
	await expect(page.frameLocator("#a").locator("#identity")).toHaveText("A");
	await expect(page.frameLocator("#b").locator("#identity")).toHaveText("B");
	const a = page.frame({ url: first + "/" });
	const b = page.frame({ url: second + "/" });
	if (!a || !b) throw new Error("fixture_frame_missing");

	await a.evaluate(() => localStorage.setItem("work-fixture", "first only"));
	const secondStorage = await b.evaluate(() => localStorage.getItem("work-fixture"));
	expect(secondStorage).toBeNull();
	await a.goto(first);
	expect(await a.evaluate(() => localStorage.getItem("work-fixture"))).toBe("first only");

	const indexedValue = (value?: string) => new Promise<string | undefined>((done, fail) => {
		const open = indexedDB.open("fixture", 1);
		open.onupgradeneeded = () => { open.result.createObjectStore("settings"); };
		open.onerror = () => fail(open.error);
		open.onsuccess = () => {
			const db = open.result;
			const transaction = db.transaction("settings", "readwrite");
			const store = transaction.objectStore("settings");
			if (value !== undefined) store.put(value, "proof");
			const read = store.get("proof");
			transaction.oncomplete = () => { db.close(); done(read.result); };
			transaction.onabort = () => { db.close(); fail(transaction.error); };
		};
	});
	expect(await a.evaluate(indexedValue, "A only")).toBe("A only");
	expect(await b.evaluate(indexedValue)).toBeUndefined();
	await b.evaluate(() => {
		const channel = new BroadcastChannel("works-fixture");
		const received: string[] = [];
		channel.onmessage = ({ data }) => {
			received.push(String(data));
			document.body.dataset.broadcast = JSON.stringify(received);
		};
	});
	await a.evaluate(() => {
		const channel = new BroadcastChannel("works-fixture");
		channel.postMessage("from A");
		channel.close();
	});
	await b.evaluate(() => {
		const channel = new BroadcastChannel("works-fixture");
		channel.postMessage("from B");
		channel.close();
	});
	await expect(b.locator("body")).toHaveAttribute("data-broadcast", '["from B"]');

	await page.locator("#share").click();
	await expect(a.locator("#asset")).toHaveText("1");
	await expect(b.locator("#asset")).toBeEmpty();

	const checks = await a.evaluate(async (coreOrigin) => {
		const asset = await (await fetch("/assets/fixture.json")).json();
		const styleLoaded = getComputedStyle(document.querySelector("#screen")!).color === "rgb(23, 119, 96)";
		let parentPrivate = false;
		try { void window.parent.document.title; } catch { parentPrivate = true; }
		let apiBlocked = false;
		try { await fetch(coreOrigin + "/api/settings"); } catch { apiBlocked = true; }
		let serviceWorkerBlocked = false;
		try { await navigator.serviceWorker.register("/sw.js"); } catch { serviceWorkerBlocked = true; }
		return { assetLoaded: asset.local === true, styleLoaded, parentPrivate, apiBlocked, serviceWorkerBlocked };
	}, core);
	expect(checks, "asset, parent and worker boundaries").toEqual({
		assetLoaded: true, styleLoaded: true, parentPrivate: true, apiBlocked: true, serviceWorkerBlocked: true,
	});
	expect(attemptedCoreApi).toEqual([]);
	expect(workerRequests).toEqual([]);
	expect(await b.locator("body").getAttribute("data-broadcast")).toBe('["from B"]');

	const busyStarted = page.waitForEvent("console", {
		predicate: (message) => message.text() === "works-fixture-busy-started",
		timeout: 2_000,
	});
	const busy = a.evaluate(() => {
		console.log("works-fixture-busy-started");
		const until = performance.now() + 4_000;
		while (performance.now() < until) {
			// Bounded fixture for an unresponsive animation.
		}
	}).then(() => "finished", () => "detached");
	await busyStarted;
	const stoppedBeforeWorkACompleted = await Promise.race([
		(async () => {
			await expect(b.locator("#screen")).toHaveText("ready", { timeout: 2_000 });
			await page.locator("#stop").click({ timeout: 2_000 });
			await expect(page.locator("#a")).toHaveCount(0, { timeout: 2_000 });
			return true;
		})(),
		busy.then((state) => state === "detached"),
	]);
	if (!observeStall)
		expect(stoppedBeforeWorkACompleted, "A can be stopped while run is busy and B is usable").toBe(true);
	await expect(page.frameLocator("#b").locator("#screen")).toHaveText("ready");

	const expectedHosts = [core, first, second].map((origin) => new URL(origin).host).sort();
	expect([...seenHosts].sort()).toEqual(expectedHosts);
	if (listener) {
		const unknown = await fetch(`http://${loopback}:${port}/`);
		expect(unknown.status).toBe(421);
		const method = await fetch(`http://${loopback}:${port}/`, {
			method: "POST", headers: { host: new URL(core).host },
		});
		expect(method.status).toBe(405);
	}
	outcome = {
		chromium: browser.version(),
		browserChannel: useChrome ? "chrome" : "playwright-headless-shell",
		interceptedRoutesOnly: !listener, forceSiteIsolation, ...checks,
		separateStorage: secondStorage === null, restoredStorage: true,
		indexedDbIsolated: true, broadcastChannelIsolated: true,
		assetTransferToSelectedFrame: true,
		stoppedBeforeWorkACompleted,
		...(listener ? {
			listeners: 1, bindAddress: loopback, port, hosts: expectedHosts,
			unknownHostRejected: true, nonGetRejected: true,
		} : {}),
	};
} finally {
	try {
		await browser?.close();
	} finally {
		if (listener) {
			await listener.stop(true);
			const result = await new Promise<string>((done) => {
				const socket = createConnection({ host: loopback, port });
				socket.setTimeout(1_000);
				socket.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? "unknown"));
				socket.once("connect", () => { socket.destroy(); done("connected"); });
				socket.once("timeout", () => { socket.destroy(); done("timeout"); });
			});
			expect(result).toBe("ECONNREFUSED");
			if (outcome) outcome.listenerStopped = true;
		}
	}
}

console.log(JSON.stringify(outcome, null, 2));
