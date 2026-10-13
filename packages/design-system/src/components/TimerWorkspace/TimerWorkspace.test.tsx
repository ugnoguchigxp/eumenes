import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TimerWorkspace } from "./TimerWorkspace";

afterEach(cleanup);
test("mode buttons expose their selection and fixed timer controls survive every state", () => {
	const props = {
		onStart: vi.fn(),
		onPause: vi.fn(),
		onResume: vi.fn(),
		onNew: vi.fn(),
		stopwatch: { elapsedMs: 0, running: false },
		durationSeconds: 600,
	};
	const view = render(<TimerWorkspace {...props} state="setup" />);
	fireEvent.click(screen.getByRole("button", { name: "10分" }));
	const dial = screen.getByRole("timer");
	expect(dial).toHaveTextContent("00:10:00");
	const fields = screen.getByRole("group", { name: "設定時間" });
	const presets = screen.getByRole("group", { name: "よく使う時間" });
	expect(
		screen.getByRole("button", { name: "タイマー", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	expect(screen.queryByRole("tablist")).toBeNull();
	for (const state of ["active", "paused", "elapsed"] as const) {
		view.rerender(
			<TimerWorkspace
				{...props}
				state={state}
				remainingSeconds={state === "elapsed" ? 0 : 550}
			/>,
		);
		expect(screen.getByRole("timer")).toBe(dial);
		expect(screen.getByRole("group", { name: "設定時間" })).toBe(fields);
		expect(screen.getByRole("group", { name: "よく使う時間" })).toBe(presets);
		expect(screen.getByLabelText("分")).toHaveValue(10);
		expect(screen.getByLabelText("分")).toHaveAttribute("readonly");
		expect(screen.getByRole("button", { name: "10分" })).toBeDisabled();
	}
});
test("timer pause and resume stay beside new timer controls", () => {
	const pause = vi.fn(),
		resume = vi.fn(),
		create = vi.fn();
	const props = {
		remainingSeconds: 65,
		durationSeconds: 180,
		onPause: pause,
		onResume: resume,
		onNew: create,
	};
	const view = render(<TimerWorkspace {...props} state="active" />);
	fireEvent.click(screen.getByRole("button", { name: "停止する" }));
	expect(pause).toHaveBeenCalledOnce();
	for (const state of ["paused", "cancelled"] as const) {
		view.rerender(<TimerWorkspace {...props} state={state} />);
		expect(screen.getByRole("timer")).toHaveTextContent("01:05");
		fireEvent.click(screen.getByRole("button", { name: "再開する" }));
		expect(
			screen.getByRole("button", { name: "新しいタイマー" }),
		).toBeVisible();
	}
	expect(resume).toHaveBeenCalledTimes(2);
	view.rerender(
		<TimerWorkspace {...props} state="cancelled" remainingSeconds={0} />,
	);
	expect(screen.queryByRole("button", { name: "再開する" })).toBeNull();
});
test("presets change the editable time without a name field", () => {
	const start = vi.fn();
	render(<TimerWorkspace state="setup" onStart={start} />);
	expect(screen.queryByLabelText("名前（任意）")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "25分" }));
	expect(
		screen.getByRole("button", { name: "25分" }).getAttribute("aria-pressed"),
	).toBe("true");
	fireEvent.change(screen.getByLabelText("秒"), { target: { value: "30" } });
	fireEvent.submit(screen.getByLabelText("分").closest("form")!);
	expect(start).toHaveBeenCalledWith({
		hours: "00",
		minutes: "25",
		seconds: "30",
	});
});

test("stopwatch controls delegate start, stop and reset to the host", () => {
	const start = vi.fn(),
		stop = vi.fn(),
		reset = vi.fn(),
		mode = vi.fn();
	const props = {
		state: "setup" as const,
		mode: "stopwatch" as const,
		onModeChange: mode,
		onStopwatchStart: start,
		onStopwatchStop: stop,
		onStopwatchReset: reset,
	};
	const view = render(
		<TimerWorkspace {...props} stopwatch={{ elapsedMs: 0, running: false }} />,
	);
	fireEvent.click(screen.getByRole("button", { name: "開始する" }));
	expect(start).toHaveBeenCalledOnce();
	view.rerender(
		<TimerWorkspace
			{...props}
			stopwatch={{ elapsedMs: 12345, running: true }}
		/>,
	);
	expect(screen.getByRole("timer")).toHaveTextContent("00:12");
	expect(screen.getByText(".34")).toBeVisible();
	expect(screen.getByRole("button", { name: "リセット" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "停止する" }));
	expect(stop).toHaveBeenCalledOnce();
	view.rerender(
		<TimerWorkspace
			{...props}
			stopwatch={{ elapsedMs: 12345, running: false }}
		/>,
	);
	expect(screen.getByRole("button", { name: "再開する" })).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "リセット" }));
	expect(reset).toHaveBeenCalledOnce();
	fireEvent.click(
		screen.getByRole("button", { name: "タイマー", exact: true }),
	);
	expect(mode).toHaveBeenCalledWith("timer");
});
test("a pending operation blocks another submit and preset edits", () => {
	const start = vi.fn();
	render(<TimerWorkspace state="setup" busy onStart={start} />);
	fireEvent.submit(
		screen.getByRole("button", { name: "開始する" }).closest("form")!,
	);
	expect(start).not.toHaveBeenCalled();
	expect(screen.getByLabelText("分")).toBeDisabled();
	expect(screen.getByRole("button", { name: "5分" })).toBeDisabled();
});
test("the running display reports host time and cancellation, without creating a local clock", () => {
	const cancel = vi.fn();
	const view = render(
		<TimerWorkspace
			state="active"
			remainingSeconds={90}
			durationSeconds={180}
			onCancel={cancel}
		/>,
	);
	expect(screen.getByRole("timer")).toHaveTextContent("01:30");
	fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
	expect(cancel).toHaveBeenCalledOnce();
	view.rerender(
		<TimerWorkspace
			state="elapsed"
			remainingSeconds={0}
			durationSeconds={180}
			onCancel={cancel}
		/>,
	);
	expect(screen.getByRole("timer")).toHaveTextContent("00:00");
	expect(screen.queryByRole("button", { name: "取り消す" })).toBeNull();
	expect(screen.getByText("時間になりました")).toBeVisible();
});
