import {
	createMcpBrowserDriver,
	type McpBrowserDriverOptions,
} from "./mcp-driver";
import type { InteractDriver } from "../contracts/interact";

/** Reuses the browser driver and bounded MCP transport, with a separate memory-only browser per run. */
export function createInteractDriver(
	options: Omit<McpBrowserDriverOptions, "extensionToken" | "isolated">,
): InteractDriver {
	const driver = createMcpBrowserDriver({ ...options, isolated: true });
	return {
		...driver,
		readText: (ref, maxChars, signal) =>
			driver.readText!(ref, maxChars, signal),
	};
}
