import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_MCP_TOOLS, pinnedCliLaunch } from "../adapters/mcp-driver";
import { startMcpSession } from "../adapters/mcp-session";

/**
 * Smoke check against the real, pinned `@playwright/mcp` CLI under this runtime: it starts,
 * answers `initialize` and `tools/list`, and stops. No tool is called, so no browser opens.
 * It also pins the tool names and argument names the driver sends (version bump guard).
 */
const SENT_ARGUMENTS: Record<string, string[]> = {
	browser_tabs: ["action", "index", "url"],
	browser_navigate: ["url"],
	browser_navigate_back: [],
	browser_snapshot: [],
	browser_click: ["target", "element"],
	browser_hover: ["target", "element"],
	browser_type: ["target", "element", "text", "submit"],
	browser_select_option: ["target", "element", "values"],
	browser_press_key: ["key"],
	browser_wait_for: ["time", "text", "textGone"],
	browser_take_screenshot: ["type", "scale", "fullPage", "target", "element"],
	browser_evaluate: ["function", "target", "element"],
};

test("the pinned CLI starts under this runtime and lists the tools the driver uses", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-browser-smoke-"));
	const launch = pinnedCliLaunch();
	expect(launch.command).toBe(process.execPath);
	expect(launch.args[0]).toMatch(/@playwright[\\/]mcp[\\/]cli\.js$/);
	const session = startMcpSession({
		command: launch.command,
		args: [...launch.args, "--extension", "--output-dir", dir, "--no-webmcp"],
		cwd: dir,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			PLAYWRIGHT_MCP_EXECUTABLE_PATH: "/nonexistent/brave",
		},
	});
	try {
		const init = (await session.request(
			"initialize",
			{
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "eumenes-smoke", version: "1" },
			},
			{ timeoutMs: 30_000 },
		)) as { serverInfo?: { name?: string } };
		expect(init.serverInfo?.name).toBe("Playwright");
		session.notify("notifications/initialized");
		const listed = (await session.request(
			"tools/list",
			{},
			{ timeoutMs: 30_000 },
		)) as {
			tools: {
				name: string;
				inputSchema: { properties?: Record<string, unknown> };
			}[];
		};
		const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
		for (const name of ALLOWED_MCP_TOOLS) {
			const tool = byName.get(name);
			expect(tool, name).toBeDefined();
			for (const argument of SENT_ARGUMENTS[name] ?? [])
				expect(
					Object.keys(tool?.inputSchema.properties ?? {}),
					`${name}.${argument}`,
				).toContain(argument);
		}
		expect(Object.keys(SENT_ARGUMENTS).sort()).toEqual(
			[...ALLOWED_MCP_TOOLS].sort(),
		);
		expect(readdirSync(dir)).toEqual([]);
	} finally {
		await session.close();
		rmSync(dir, { recursive: true, force: true });
	}
	expect(session.exited()).toBe(true);
}, 60_000);
