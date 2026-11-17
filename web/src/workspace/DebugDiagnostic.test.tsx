import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../client";
import { DebugDiagnostic } from "./DebugDiagnostic";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const client = { debugDiagnosticDetail: vi.fn() } as unknown as EumenesClient;
const entry = (id: string, expiresAt: number, summary: string) => ({
	id,
	runId: "run-1",
	at: "2026-11-17T00:00:00.000Z",
	expiresAt,
	summary,
});

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

test("a diagnostic that is already expired stays hidden", () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
	render(
		<DebugDiagnostic
			client={client}
			entry={entry("old", Date.now() - 1, "期限切れ")}
			conversationId="main"
		/>,
	);
	expect(
		screen.queryByRole("complementary", { name: "デバッグ診断" }),
	).toBeNull();
});

test("a diagnostic hides when its expiry is reached", () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
	render(
		<DebugDiagnostic
			client={client}
			entry={entry("live", Date.now() + 5_000, "まだ有効")}
			conversationId="main"
		/>,
	);
	expect(screen.getByText(/まだ有効/)).toBeTruthy();
	act(() => {
		vi.advanceTimersByTime(5_000);
	});
	expect(screen.queryByText(/まだ有効/)).toBeNull();
});

test("replacing the diagnostic restarts the expiry", () => {
	vi.useFakeTimers();
	const now = Date.parse("2026-11-17T00:00:00.000Z");
	vi.setSystemTime(now);
	const view = render(
		<DebugDiagnostic
			client={client}
			entry={entry("first", now + 5_000, "一つ目")}
			conversationId="main"
		/>,
	);
	act(() => {
		vi.advanceTimersByTime(4_000);
	});
	expect(screen.getByText(/一つ目/)).toBeTruthy();
	view.rerender(
		<DebugDiagnostic
			client={client}
			entry={entry("second", now + 4_000 + 20_000, "二つ目")}
			conversationId="main"
		/>,
	);
	act(() => {
		vi.advanceTimersByTime(5_000);
	});
	expect(screen.getByText(/二つ目/)).toBeTruthy();
	view.rerender(
		<DebugDiagnostic
			client={client}
			entry={entry("third", Date.now() - 1, "三つ目")}
			conversationId="main"
		/>,
	);
	expect(screen.queryByText(/三つ目/)).toBeNull();
});
