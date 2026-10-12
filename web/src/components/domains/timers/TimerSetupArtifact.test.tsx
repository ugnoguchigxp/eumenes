import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../../client";
import { timerSetupDefinition } from "../../../domains/timers/artifact-definition";
import { TimerSetupArtifact } from "./TimerSetupArtifact";

afterEach(cleanup);

function setup(startTimer = vi.fn()) {
	const onStarted = vi.fn();
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={cache}>
			<TimerSetupArtifact
				client={{ startTimer } as unknown as EumenesClient}
				definition={timerSetupDefinition()}
				onStarted={onStarted}
			/>
		</QueryClientProvider>,
	);
	return { startTimer, onStarted };
}

test("the shared form starts the entered duration and opens only the saved reference", async () => {
	const api = setup(
		vi.fn(async () => ({
			action: "started",
			artifact: { timerId: "saved" },
			timer: { label: "休憩" },
		})),
	);
	fireEvent.change(await screen.findByLabelText("分"), {
		target: { value: "1" },
	});
	fireEvent.change(screen.getByLabelText("秒"), { target: { value: "30" } });
	fireEvent.change(screen.getByLabelText("名前（任意）"), {
		target: { value: "休憩" },
	});
	fireEvent.click(screen.getByRole("button", { name: "開始する" }));
	await waitFor(() =>
		expect(api.onStarted).toHaveBeenCalledWith({ timerId: "saved" }, "休憩"),
	);
	expect(api.startTimer).toHaveBeenCalledWith(
		expect.objectContaining({ durationSeconds: 90, label: "休憩" }),
	);
});

test.each([
	["0", "0"],
	["-1", "120"],
	["1440", "1"],
	["0.5", "30"],
])("invalid duration %s:%s never starts a timer", async (minutes, seconds) => {
	const api = setup();
	fireEvent.change(await screen.findByLabelText("分"), {
		target: { value: minutes },
	});
	fireEvent.change(screen.getByLabelText("秒"), { target: { value: seconds } });
	fireEvent.click(screen.getByRole("button", { name: "開始する" }));
	await screen.findByText(/入力してください/);
	expect(api.startTimer).not.toHaveBeenCalled();
	expect(api.onStarted).not.toHaveBeenCalled();
});

test("a failed start keeps the form available without opening a clock", async () => {
	const api = setup(
		vi.fn(async () => {
			throw new Error("offline");
		}),
	);
	fireEvent.click(await screen.findByRole("button", { name: "開始する" }));
	await screen.findByText("操作に失敗しました。もう一度お試しください");
	expect(api.onStarted).not.toHaveBeenCalled();
	expect(
		screen.getByRole("button", { name: "開始する" }).hasAttribute("disabled"),
	).toBe(false);
});
