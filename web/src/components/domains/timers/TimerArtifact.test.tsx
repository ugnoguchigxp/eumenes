import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { TimerArtifact } from "./TimerArtifact";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
test("clock binding measures the real request round trip before rendering", async () => {
	let mono = 100;
	vi.spyOn(performance, "now").mockImplementation(() => mono);
	const api = {
		timer: vi.fn(async () => {
			mono = 2100;
			return {
				serverNow: "2026-10-10T00:00:00Z",
				timer: {
					id: "timer",
					durationSeconds: 3,
					state: "active",
					dueAt: "2026-10-10T00:00:03Z",
					cancelledAt: null,
					label: "タイマー",
					bodyExpired: false,
				},
			};
		}),
	};
	const cache = new QueryClient();
	render(
		<QueryClientProvider client={cache}>
			<TimerArtifact client={api as never} timerId="timer" />
		</QueryClientProvider>,
	);
	await waitFor(() =>
		expect(screen.getByRole("timer").textContent).toBe("00:02"),
	);
	expect(api.timer.mock.calls[0]).toHaveLength(2);
});
