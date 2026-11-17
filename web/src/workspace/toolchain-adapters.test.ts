import { expect, test } from "vitest";
import { shellWebAdapter } from "../domains/shell/toolchain-adapter";
import {
	loadToolchainAdapter,
	prepareToolchainAdapter,
	toolchainAdapterPhase,
	toolchainWebAdapters,
} from "./toolchain-adapters";

test("a domain screen stays unloaded until that screen is opened", async () => {
	expect(toolchainAdapterPhase("adapter:shell@1")).toBe("pending");
	expect(toolchainWebAdapters.get("adapter:shell@1")).toBeUndefined();
	expect(toolchainAdapterPhase("adapter:not-registered@1")).toBe("generic");
	expect(await prepareToolchainAdapter("adapter:not-registered@1")).toBe(
		"generic",
	);
	expect(await loadToolchainAdapter("adapter:shell@1")).toBe(shellWebAdapter);
	expect(toolchainAdapterPhase("adapter:shell@1")).toBe("ready");
	expect(toolchainAdapterPhase("adapter:video@1")).toBe("pending");
});
