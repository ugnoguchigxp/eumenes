import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { StrictMode, useState } from "react";
import { TimerNotifications } from "./TimerNotifications";
import { queryRoots } from "../../../queryKeys";

const NOW = "2026-10-10T00:00:01.000Z";
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
function fixture(status = "pending", extraPages = false) {
	let note = {
		id: "notice",
		timerId: "timer",
		revision: 0,
		status,
		dueAt: NOW,
		reason: null,
		generation: 1,
		message: "3分のタイマーが終了しました。",
	};
	const api = {
		timerNotifications: vi.fn(async (query: { cursor?: string }) =>
			extraPages && !query.cursor
				? { serverNow: NOW, items: [], nextCursor: "page2" }
				: { serverNow: NOW, items: [note], nextCursor: null },
		),
		claimTimerNotification: vi.fn(async () => {
			note = { ...note, status: "claimed", revision: 1 };
			return {
				serverNow: NOW,
				notification: note,
				claimId: "claim",
				leaseUntil: "2026-10-10T00:00:16.000Z",
			};
		}),
		ackTimerNotification: vi.fn(async (_id, input) => {
			note = {
				...note,
				status: input.outcome === "played" ? "played" : "silent",
				revision: 2,
			};
		}),
		silenceTimerNotification: vi.fn(async () => {
			note = { ...note, status: "silent", revision: 1 };
		}),
		timer: vi.fn(async () => ({
			serverNow: NOW,
			timer: { id: "timer", revision: 3 },
		})),
		cancelTimer: vi.fn(async () => {
			note = { ...note, status: "dismissed", revision: 4 };
		}),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const show = (playTone: (signal: AbortSignal) => Promise<void>, props = {}) =>
		render(
			<QueryClientProvider client={cache}>
				<TimerNotifications
					client={api as never}
					playTone={playTone}
					{...props}
				/>
			</QueryClientProvider>,
		);
	const refresh = () =>
		act(async () => {
			await cache.invalidateQueries({
				queryKey: [queryRoots.timers, "notifications"],
			});
		});
	return { api, cache, show, refresh };
}

test("polling an owned claim keeps the tone alive and acknowledges only its completion", async () => {
	const h = fixture();
	let end!: () => void;
	const tone = vi.fn(
		(_signal: AbortSignal) =>
			new Promise<void>((resolve) => {
				end = resolve;
			}),
	);
	h.show(tone);
	await waitFor(() => expect(tone).toHaveBeenCalledOnce());
	expect(tone).toHaveBeenCalledWith(
		expect.any(AbortSignal),
		"3分のタイマーが終了しました。",
		expect.any(Function),
	);
	await h.refresh();
	expect(tone.mock.calls[0]![0].aborted).toBe(false);
	expect(h.api.ackTimerNotification).not.toHaveBeenCalled();
	await act(async () => {
		end();
	});
	await waitFor(() =>
		expect(h.api.ackTimerNotification).toHaveBeenCalledWith(
			"notice",
			expect.objectContaining({ outcome: "played", claimId: "claim" }),
		),
	);
	expect(tone).toHaveBeenCalledOnce();
});

test("blocked audio settles the owned claim, and the silent notice can be dismissed", async () => {
	const h = fixture();
	h.show(async () => {
		throw new Error("autoplay_blocked");
	});
	await waitFor(() =>
		expect(h.api.ackTimerNotification).toHaveBeenCalledWith(
			"notice",
			expect.objectContaining({ outcome: "blocked" }),
		),
	);
	expect(h.api.silenceTimerNotification).not.toHaveBeenCalled();
	await waitFor(() => expect(screen.getByText(/通知音なし/)).toBeTruthy());
	fireEvent.click(screen.getByRole("button", { name: "通知を停止" }));
	await waitFor(() =>
		expect(h.api.cancelTimer).toHaveBeenCalledWith("timer", {
			requestId: expect.any(String),
			issuedAt: NOW,
			expectedRevision: 3,
		}),
	);
	await waitFor(() =>
		expect(screen.queryByRole("button", { name: "通知を停止" })).toBeNull(),
	);
});

test("pagination and a skewed client wall clock do not lose a fresh pending notice", async () => {
	const h = fixture("pending", true);
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2036-01-01T00:00:00Z"));
	const tone = vi.fn(async () => {});
	h.show(tone);
	await waitFor(() => expect(tone).toHaveBeenCalledOnce());
	expect(h.api.timerNotifications).toHaveBeenCalledWith(
		expect.objectContaining({ cursor: "page2" }),
		expect.any(AbortSignal),
	);
});

test("muted notices stay visible without claiming or playing audio", async () => {
	const h = fixture();
	const tone = vi.fn(async () => {});
	h.show(tone, { muted: true });
	await waitFor(() =>
		expect(h.api.silenceTimerNotification).toHaveBeenCalledOnce(),
	);
	expect(tone).not.toHaveBeenCalled();
	expect(h.api.claimTimerNotification).not.toHaveBeenCalled();
});

test("an unprepared browser retains the pending alarm until audio is enabled", async () => {
	const h = fixture();
	const tone = vi.fn(async () => {});
	function Notice() {
		const [ready, setReady] = useState(false);
		return (
			<TimerNotifications
				client={h.api as never}
				playTone={tone}
				audioReady={ready}
				prepareAudio={async () => setReady(true)}
			/>
		);
	}
	render(
		<QueryClientProvider client={h.cache}>
			<Notice />
		</QueryClientProvider>,
	);
	await waitFor(() =>
		expect(screen.getByText("3分のタイマーが終了しました。")).toBeTruthy(),
	);
	expect(h.api.claimTimerNotification).not.toHaveBeenCalled();
	expect(h.api.ackTimerNotification).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "通知音を有効にする" }));
	await waitFor(() => expect(tone).toHaveBeenCalledOnce());
	await waitFor(() =>
		expect(h.api.ackTimerNotification).toHaveBeenCalledWith(
			"notice",
			expect.objectContaining({ outcome: "played" }),
		),
	);
});

test("busy output defers the claim until output becomes free", async () => {
	const h = fixture();
	const tone = vi.fn(async () => {});
	const view = h.show(tone, { busy: true });
	await screen.findByRole("button", { name: "通知を停止" });
	expect(h.api.claimTimerNotification).not.toHaveBeenCalled();
	view.rerender(
		<QueryClientProvider client={h.cache}>
			<TimerNotifications
				client={h.api as never}
				playTone={tone}
				busy={false}
			/>
		</QueryClientProvider>,
	);
	await waitFor(() => expect(tone).toHaveBeenCalledOnce());
});

test("dismissing a claimed notice aborts playback and never adopts played", async () => {
	const h = fixture();
	const tone = vi.fn(
		(signal: AbortSignal) =>
			new Promise<void>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(new Error("stopped"))),
			),
	);
	h.show(tone);
	await waitFor(() => expect(tone).toHaveBeenCalledOnce());
	fireEvent.click(screen.getByRole("button", { name: "通知を停止" }));
	await waitFor(() => expect(h.api.cancelTimer).toHaveBeenCalledOnce());
	expect(tone.mock.calls[0]![0].aborted).toBe(true);
	expect(
		h.api.ackTimerNotification.mock.calls.every(
			(call) => call[1].outcome !== "played",
		),
	).toBe(true);
});

test("StrictMode effect replay does not abort a notice when the first claim finishes", async () => {
	const h = fixture();
	const tone = vi.fn(async () => {});
	render(
		<StrictMode>
			<QueryClientProvider client={h.cache}>
				<TimerNotifications client={h.api as never} playTone={tone} />
			</QueryClientProvider>
		</StrictMode>,
	);
	await waitFor(() =>
		expect(h.api.ackTimerNotification).toHaveBeenCalledWith(
			"notice",
			expect.objectContaining({ outcome: "played" }),
		),
	);
	expect(tone).toHaveBeenCalledOnce();
});

test("an active speech capture defers the notice while an idle voice listener allows it", async () => {
	const h = fixture();
	let speaking = true;
	const tone = vi.fn(async () => {});
	h.show(tone, { inputBusy: () => speaking });
	await screen.findByRole("button", { name: "通知を停止" });
	expect(h.api.claimTimerNotification).not.toHaveBeenCalled();
	speaking = false;
	await h.refresh();
	await waitFor(() => expect(tone).toHaveBeenCalledOnce());
});

test("interrupting speech after a delivered beep settles the notice and does not repeat the beep", async () => {
	const h = fixture();
	const tone = vi.fn(
		(signal: AbortSignal, _message?: string, delivered?: () => void) => {
			delivered?.();
			return new Promise<void>((_resolve, reject) =>
				signal.addEventListener(
					"abort",
					() => reject(new Error("interrupted")),
					{ once: true },
				),
			);
		},
	);
	const view = h.show(tone);
	await waitFor(() => expect(tone).toHaveBeenCalledOnce());
	const renderNotice = (busy: boolean) => (
		<QueryClientProvider client={h.cache}>
			<TimerNotifications client={h.api as never} playTone={tone} busy={busy} />
		</QueryClientProvider>
	);
	view.rerender(renderNotice(true));
	await waitFor(() =>
		expect(h.api.ackTimerNotification).toHaveBeenCalledWith(
			"notice",
			expect.objectContaining({ outcome: "played" }),
		),
	);
	view.rerender(renderNotice(false));
	await h.refresh();
	expect(tone).toHaveBeenCalledOnce();
});

test("after speech completes the owning client keeps ringing until the notice is stopped", async () => {
	const h = fixture();
	const tone = vi.fn(async () => {});
	let ringingSignal: AbortSignal | undefined;
	const repeatTone = vi.fn((signal: AbortSignal) => {
		ringingSignal = signal;
		return new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true }),
		);
	});
	h.show(tone, { repeatTone });
	await waitFor(() => expect(repeatTone).toHaveBeenCalledOnce());
	expect(tone).toHaveBeenCalledOnce();
	expect(h.api.ackTimerNotification).toHaveBeenCalledWith(
		"notice",
		expect.objectContaining({ outcome: "played" }),
	);
	await h.refresh();
	expect(repeatTone).toHaveBeenCalledOnce();
	expect(ringingSignal?.aborted).toBe(false);
	fireEvent.click(screen.getByRole("button", { name: /通知センター/ }));
	await screen.findByRole("dialog", { name: "通知センター" });
	expect(ringingSignal?.aborted).toBe(false);
	fireEvent.click(screen.getByRole("button", { name: "通知センターを閉じる" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(ringingSignal?.aborted).toBe(false);
	expect(tone).toHaveBeenCalledOnce();
	fireEvent.click(screen.getByRole("button", { name: /通知センター/ }));
	await screen.findByRole("dialog", { name: "通知センター" });
	fireEvent.click(screen.getByRole("button", { name: "通知を停止" }));
	expect(ringingSignal?.aborted).toBe(true);
	await waitFor(() => expect(h.api.cancelTimer).toHaveBeenCalledOnce());
});

test("a played notice restored in another client does not start a second alarm", async () => {
	const h = fixture("played");
	const repeatTone = vi.fn(async () => {});
	h.show(
		vi.fn(async () => {}),
		{ repeatTone },
	);
	await waitFor(() =>
		expect(screen.getByText("3分のタイマーが終了しました。")).toBeTruthy(),
	);
	expect(repeatTone).not.toHaveBeenCalled();
});

test("ringing pauses for another voice and resumes without repeating the announcement", async () => {
	const h = fixture();
	const tone = vi.fn(async () => {});
	const signals: AbortSignal[] = [];
	const repeatTone = vi.fn((signal: AbortSignal) => {
		signals.push(signal);
		return new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true }),
		);
	});
	const view = (busy: boolean) => (
		<QueryClientProvider client={h.cache}>
			<TimerNotifications
				client={h.api as never}
				playTone={tone}
				repeatTone={repeatTone}
				busy={busy}
			/>
		</QueryClientProvider>
	);
	const host = render(view(false));
	await waitFor(() => expect(repeatTone).toHaveBeenCalledOnce());
	host.rerender(view(true));
	expect(signals[0]?.aborted).toBe(true);
	host.rerender(view(false));
	await waitFor(() => expect(repeatTone).toHaveBeenCalledTimes(2));
	expect(tone).toHaveBeenCalledOnce();
	host.unmount();
	expect(signals[1]?.aborted).toBe(true);
});

test("notification center remains available when there are no notices", async () => {
	const h = fixture("dismissed");
	h.show(async () => {});
	await h.refresh();
	expect(screen.queryByRole("status", { name: "タイマーの終了" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "通知センター" }));
	await screen.findByRole("dialog", { name: "通知センター" });
	expect(screen.getByText("通知はありません")).toBeTruthy();
});

test("banners show the newest three while the drawer contains the entire notification list", async () => {
	const h = fixture("played");
	h.api.timerNotifications.mockImplementation(async () => ({
		serverNow: NOW,
		nextCursor: null,
		items: [0, 1, 2, 3, 4].map((index) => ({
			id: `notice-${index}`,
			timerId: `timer-${index}`,
			generation: 1,
			revision: 0,
			status: "played",
			reason: null,
			dueAt: new Date(Date.parse(NOW) - index * 60000).toISOString(),
			message: `終了したタイマー ${index}`,
		})),
	}));
	h.show(async () => {});
	await screen.findByText("終了したタイマー 0");
	expect(screen.queryByText("終了したタイマー 3")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "ほか2件の通知を見る" }));
	await screen.findByRole("dialog", { name: "通知センター" });
	expect(screen.getByText("終了したタイマー 4")).toBeTruthy();
	expect(
		screen
			.getAllByRole("article")
			.map((article) => article.textContent?.match(/終了したタイマー \d/)?.[0]),
	).toEqual([
		"終了したタイマー 0",
		"終了したタイマー 1",
		"終了したタイマー 2",
		"終了したタイマー 3",
		"終了したタイマー 4",
	]);
});

test("a finished timer is announced as an alert inside a polite status region", async () => {
	const h = fixture("played");
	h.show(async () => {});
	const region = await screen.findByRole("status", { name: "タイマーの終了" });
	expect(region.getAttribute("aria-live")).toBe("polite");
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("3分のタイマーが終了しました。");
	expect(region.contains(alert)).toBe(true);
});

test("a failing claim is retried with exponential backoff instead of at network speed", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	try {
		const h = fixture();
		h.api.claimTimerNotification.mockRejectedValue(new Error("http_500"));
		const tone = vi.fn(async () => {});
		h.show(tone);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		for (let second = 0; second < 10; second += 1) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});
		}
		expect(h.api.claimTimerNotification.mock.calls.length).toBeGreaterThan(1);
		expect(h.api.claimTimerNotification.mock.calls.length).toBeLessThanOrEqual(
			5,
		);
		expect(tone).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
	}
});

test("a notice that already sounded is acknowledged without ringing again when it returns pending", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	try {
		const h = fixture();
		h.api.ackTimerNotification.mockRejectedValueOnce(new Error("http_500"));
		h.api.ackTimerNotification.mockRejectedValueOnce(new Error("http_500"));
		const tone = vi.fn(
			async (_signal: AbortSignal, _message?: string, done?: () => void) => {
				done?.();
			},
		);
		h.show(tone);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(tone).toHaveBeenCalledOnce();
		expect(h.api.ackTimerNotification).toHaveBeenCalledTimes(2);
		// The server lost the ack: the lease expired and the notice is pending again.
		h.api.timerNotifications.mockImplementation((async () => ({
			serverNow: NOW,
			nextCursor: null,
			items: [
				{
					id: "notice",
					timerId: "timer",
					revision: 3,
					status: "pending",
					dueAt: NOW,
					reason: null,
					generation: 1,
					message: "3分のタイマーが終了しました。",
				},
			],
		})) as never);
		await h.refresh();
		for (let second = 0; second < 5; second += 1) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});
		}
		expect(tone).toHaveBeenCalledOnce();
		expect(h.api.claimTimerNotification.mock.calls.length).toBeGreaterThan(1);
		expect(h.api.ackTimerNotification).toHaveBeenLastCalledWith(
			"notice",
			expect.objectContaining({ outcome: "played" }),
		);
	} finally {
		vi.useRealTimers();
	}
});
