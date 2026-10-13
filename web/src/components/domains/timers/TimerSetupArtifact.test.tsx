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
import { TimerArtifact } from "./TimerArtifact";
import { useState } from "react";

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

function savedReceipt(durationSeconds = 90) {
	const now = Date.now();
	return {
		kind: "timer_action" as const,
		action: "started" as const,
		operationId: crypto.randomUUID(),
		serverNow: new Date(now).toISOString(),
		artifact: { kind: "timer" as const, version: 1 as const, timerId: "saved" },
		timer: {
			id: "saved",
			label: "タイマー",
			revision: 0,
			state: "active" as const,
			durationSeconds,
			remainingSeconds: durationSeconds,
			startedAt: new Date(now).toISOString(),
			dueAt: new Date(now + durationSeconds * 1000).toISOString(),
			cancelledAt: null,
			pausedAt: null,
			bodyExpired: false,
			conversationId: null,
			originRunId: null,
			originMessageId: null,
			errorCode: null,
		},
	};
}

test("a confirmed start stays on the clock while the first read is pending", async () => {
	const receipt = savedReceipt(180);
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const client = {
		startTimer: vi.fn(async () => receipt),
		timer: vi.fn(() => new Promise(() => {})),
	} as unknown as EumenesClient;
	function Host() {
		const [id, setId] = useState<string | null>(null);
		return id ? (
			<TimerArtifact client={client} timerId={id} />
		) : (
			<TimerSetupArtifact
				client={client}
				definition={timerSetupDefinition()}
				onStarted={(ref) => setId(ref.timerId)}
			/>
		);
	}
	render(
		<QueryClientProvider client={cache}>
			<Host />
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "開始する" }));
	await screen.findByRole("button", { name: "停止する" });
	await waitFor(() => expect(client.timer).toHaveBeenCalled());
	expect(screen.getByRole("timer")).toBeDefined();
	expect((screen.getByLabelText("分") as HTMLInputElement).value).toBe("03");
	expect(screen.getByRole("group", { name: "よく使う時間" })).toBeDefined();
	expect(screen.queryByText("タイマーを読み込んでいます")).toBeNull();
});

test("the clock starts an unnamed duration and opens only the saved reference", async () => {
	const api = setup(vi.fn(async () => savedReceipt()));
	fireEvent.change(await screen.findByLabelText("分"), {
		target: { value: "1" },
	});
	fireEvent.change(screen.getByLabelText("秒"), { target: { value: "30" } });
	expect(screen.queryByLabelText("名前（任意）")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "開始する" }));
	await waitFor(() =>
		expect(api.onStarted).toHaveBeenCalledWith(
			{ kind: "timer", version: 1, timerId: "saved" },
			"タイマー",
		),
	);
	expect(api.startTimer).toHaveBeenCalledWith(
		expect.objectContaining({ durationSeconds: 90 }),
	);
	expect(api.startTimer.mock.calls[0]?.[0]).not.toHaveProperty("label");
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
