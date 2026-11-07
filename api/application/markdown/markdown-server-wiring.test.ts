import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../infrastructure/config";
import { buildServices } from "../server-services";
import { appServices } from "../server-app-services";
import { appModules } from "../app-modules";
import { createApp } from "../app";
import { createLifecycles } from "../server-lifecycles";
import { createLifecycleRunner } from "../lifecycle";

/** Real production assembly, in-memory HTTP only: never starts a server or lifecycle. */
test("production app assembly mounts resident Markdown routes even when Desk has no connection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-markdown-wiring-"));
	const services = await buildServices(
		loadConfig({
			EUMENES_DB: join(dir, "test.sqlite"),
			EUMENES_TOOLCHAIN_ENABLED: "0",
			EUMENES_WORLD: "protect",
		}),
	);
	try {
		const app = createApp({
			token: "fixture-markdown-wiring-token",
			origin: "http://test.local",
			modules: appModules(appServices(services)),
		});
		const headers = {
			authorization: "Bearer fixture-markdown-wiring-token",
			"content-type": "application/json",
		};
		const caps = await app.request("/api/markdown/capabilities", { headers });
		expect(caps.status).toBe(503);
		expect(await caps.json()).toEqual({
			error: "markdown_docling_unconfigured",
		});
		const list = await app.request("/api/markdown/library", { headers });
		expect(list.status).toBe(503);
		expect(await list.json()).toEqual({
			error: "markdown_docling_unconfigured",
		});
		const stage = await app.request("/api/markdown/inputs", {
			method: "POST",
			headers,
			body: JSON.stringify({
				document: {
					formatVersion: 1,
					nodes: [{ type: "p", children: [{ text: "文書の入口を確認" }] }],
					originalMarkdown: null,
				},
			}),
		});
		expect(stage.status).toBe(201);
		expect(await stage.json()).toMatchObject({ id: expect.any(String) });
	} finally {
		expect(
			await createLifecycleRunner(
				createLifecycles(services, { name: "http", close() {} }),
			).closeAll(15000),
		).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	}
}, 30000);
