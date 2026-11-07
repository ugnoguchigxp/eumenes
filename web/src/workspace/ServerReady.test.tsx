import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EumenesClient } from "../../../client";
import { ServerReady } from "./ServerReady";

afterEach(cleanup);

function renderGate(status: () => Promise<unknown>) {
	const client = {
		identity: "http://127.0.0.1:5173",
		status,
	} as unknown as EumenesClient;
	render(
		<QueryClientProvider client={new QueryClient()}>
			<ServerReady client={client}>
				<p>作業画面</p>
			</ServerReady>
		</QueryClientProvider>,
	);
}

test("the workspace waits while the server is starting and appears once it is ready", async () => {
	const status = vi
		.fn()
		.mockResolvedValueOnce({ service: "eumenes", phase: "starting" })
		.mockResolvedValue({
			service: "eumenes",
			phase: "ready",
			larm: { state: "ready", capabilities: [] },
		});
	renderGate(status);
	expect(await screen.findByText("サーバー起動中です。")).toBeTruthy();
	expect(screen.queryByText("作業画面")).toBeNull();
	expect(
		await screen.findByText("作業画面", {}, { timeout: 3000 }),
	).toBeTruthy();
	expect(status.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test("an unreachable server is left to the workspace's own connection display", async () => {
	renderGate(() => Promise.reject(new Error("api_connection_failed")));
	expect(await screen.findByText("作業画面")).toBeTruthy();
});

test("once shown, the workspace stays when a later status says starting again (a restart)", async () => {
	const cache = new QueryClient();
	const status = vi.fn().mockResolvedValue({
		service: "eumenes",
		phase: "ready",
		larm: { state: "ready", capabilities: [] },
	});
	const client = {
		identity: "http://127.0.0.1:5173",
		status,
	} as unknown as EumenesClient;
	render(
		<QueryClientProvider client={cache}>
			<ServerReady client={client}>
				<p>作業画面</p>
			</ServerReady>
		</QueryClientProvider>,
	);
	expect(await screen.findByText("作業画面")).toBeTruthy();
	status.mockResolvedValue({ service: "eumenes", phase: "starting" });
	await cache.refetchQueries();
	expect(screen.getByText("作業画面")).toBeTruthy();
	expect(screen.queryByText("サーバー起動中です。")).toBeNull();
});

test("a failed status is not asked again every second", async () => {
	const status = vi.fn(() => Promise.reject(new Error("unavailable")));
	renderGate(status);
	expect(await screen.findByText("作業画面")).toBeTruthy();
	await new Promise((resolve) => setTimeout(resolve, 1500));
	expect(status).toHaveBeenCalledTimes(1);
});
