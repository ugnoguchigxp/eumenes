import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../../client";
import { SchedulePanel } from "./schedule";

afterEach(cleanup);
test("schedule section renders the registration form and the empty list", async () => {
	const client = {
		identity: "schedule-section",
		schedules: vi.fn(async () => ({ items: [], nextCursor: null })),
		scheduleOccurrences: vi.fn(),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={cache}>
			<SchedulePanel client={client} />
		</QueryClientProvider>,
	);
	expect(screen.getByText("会話を予約する")).toBeTruthy();
	await vi.waitFor(() => expect(client.schedules).toHaveBeenCalled());
	cache.clear();
});
