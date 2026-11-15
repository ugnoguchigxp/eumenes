import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../client";
import { DebugDiagnostic } from "./DebugDiagnostic";

afterEach(cleanup);

test("diagnostic details are fetched only when opened, for the original conversation and diagnostic", async () => {
	const entry = {
		id: "diagnostic-1",
		runId: "run-1",
		at: "2026-11-15T00:00:00.000Z",
		expiresAt: Date.now() + 60_000,
		summary: "保存以降は未確認です。",
	};
	const debugDiagnosticDetail = vi.fn(async () => ({
		...entry,
		observation: "run-1 保存済み",
	}));
	const client = { debugDiagnosticDetail } as unknown as EumenesClient;
	render(
		<DebugDiagnostic client={client} entry={entry} conversationId="main" />,
	);
	expect(debugDiagnosticDetail).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "デバッグ診断の詳細" }));
	expect(await screen.findByText("run-1 保存済み")).toBeTruthy();
	expect(debugDiagnosticDetail).toHaveBeenCalledWith(
		"main",
		"diagnostic-1",
		expect.any(AbortSignal),
	);
});
