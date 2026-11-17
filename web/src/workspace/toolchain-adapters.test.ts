import { expect, test, vi } from "vitest";
import { shellWebAdapter } from "../domains/shell/toolchain-adapter";
import {
	loadToolchainAdapter,
	prepareToolchainAdapter,
	toolchainAdapterPhase,
	toolchainWebAdapters,
} from "./toolchain-adapters";

vi.mock("../domains/video/toolchain-adapter", () => {
	throw new Error("module unavailable");
});

test("a domain screen stays unloaded until that screen is opened", async () => {
	expect(toolchainAdapterPhase("adapter:shell@1")).toBe("pending");
	expect(toolchainWebAdapters.get("adapter:shell@1")).toBeUndefined();
	expect(toolchainAdapterPhase("adapter:not-registered@1")).toBe("generic");
	expect(await prepareToolchainAdapter("adapter:not-registered@1")).toBe(
		"generic",
	);
	expect(await prepareToolchainAdapter("adapter:collaboration.future@1")).toBe(
		"generic",
	);
	expect(await loadToolchainAdapter("adapter:shell@1")).toBe(shellWebAdapter);
	expect(toolchainAdapterPhase("adapter:shell@1")).toBe("ready");
	expect(toolchainAdapterPhase("adapter:video@1")).toBe("pending");
});

test("a registered screen's import failure resolves as unavailable", async () => {
	expect(await prepareToolchainAdapter("adapter:video@1")).toBe("unavailable");
	expect(toolchainAdapterPhase("adapter:video@1")).toBe("unavailable");
	expect(toolchainWebAdapters.get("adapter:video@1")).toBeUndefined();
});
