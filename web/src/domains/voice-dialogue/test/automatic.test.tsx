import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Run } from "../../../../../api/domains/dialogue/contracts";
import { useAutomaticSpeech } from "../hooks/automatic";

afterEach(cleanup);
type Message = { id: string; text: string };
type Inputs = {
	runs: Run[];
	messages: Message[];
	enabled: boolean;
	blocked?: boolean;
};
const answer = (
	id: string,
	sourceKind: Run["sourceKind"] = "manual",
	utteranceId: string | null = null,
) => ({
	run: {
		id,
		status: "completed",
		answerMessageId: `answer:${id}`,
		sourceKind,
		utteranceId,
	} as Run,
	message: { id: `answer:${id}`, text: `${id}。` },
});
function fixture(initial: Run[] = [], messages: Message[] = []) {
	const player = {
		play: vi.fn(
			async (
				_id: string,
				_text: string,
				_runId?: string | null,
				_options?: { automatic?: boolean },
			) => {},
		),
		stopAutomatic: vi.fn(),
		prepare: vi.fn(async () => undefined as never),
	};
	const ownsSpeech = vi.fn((id: string | null) => id === "owned");
	const initialProps: Inputs = { runs: initial, messages, enabled: true };
	const hook = renderHook(
		(props: Inputs) => useAutomaticSpeech({ ...props, player, ownsSpeech }),
		{
			initialProps,
		},
	);
	return { hook, player };
}

test("all adopted answer sources use TTS once; existing history and native playback are not repeated", async () => {
	const old = answer("old");
	const { hook, player } = fixture([old.run], [old.message]);
	const answers = [
		answer("manual"),
		answer("schedule", "schedule"),
		answer("external-voice", "voice", "external"),
		answer("native", "voice", "owned"),
	];
	const props = {
		runs: [old.run, ...answers.map((a) => a.run)],
		messages: [old.message, ...answers.map((a) => a.message)],
		enabled: true,
	};
	hook.rerender(props);
	await waitFor(() => expect(player.play).toHaveBeenCalledTimes(3));
	expect(player.play.mock.calls.map((call) => call[0])).toEqual([
		"answer:manual",
		"answer:schedule",
		"answer:external-voice",
	]);
	hook.rerender({
		...props,
		runs: [...props.runs],
		messages: [...props.messages],
	});
	expect(player.play).toHaveBeenCalledTimes(3);
});

test("streaming or cancelled answers do not speak and adoption waits for the matching message", async () => {
	const { hook, player } = fixture();
	const first = answer("first");
	hook.rerender({
		runs: [{ ...first.run, status: "running" }],
		messages: [first.message],
		enabled: true,
	});
	expect(player.play).not.toHaveBeenCalled();
	hook.rerender({ runs: [first.run], messages: [], enabled: true });
	expect(player.play).not.toHaveBeenCalled();
	hook.rerender({
		runs: [first.run],
		messages: [first.message],
		enabled: true,
	});
	await waitFor(() => expect(player.play).toHaveBeenCalledOnce());
	const cancelled = answer("cancelled");
	hook.rerender({
		runs: [first.run, { ...cancelled.run, status: "cancelled" }],
		messages: [first.message, cancelled.message],
		enabled: true,
	});
	expect(player.play).toHaveBeenCalledOnce();
});

test("mute aborts automatic playback, drops queued answers and does not read them on unmute", async () => {
	const { hook, player } = fixture();
	let finish!: () => void;
	player.play.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const answers = [answer("one"), answer("two")];
	const props = {
		runs: answers.map((a) => a.run),
		messages: answers.map((a) => a.message),
		enabled: true,
	};
	hook.rerender(props);
	await waitFor(() => expect(player.play).toHaveBeenCalledOnce());
	hook.rerender({ ...props, enabled: false });
	expect(player.stopAutomatic).toHaveBeenCalledOnce();
	await act(async () => finish());
	hook.rerender(props);
	expect(player.play).toHaveBeenCalledOnce();
	const third = answer("three");
	hook.rerender({
		runs: [...props.runs, third.run],
		messages: [...props.messages, third.message],
		enabled: true,
	});
	await waitFor(() => expect(player.play).toHaveBeenCalledTimes(2));
});

test("automatic answers wait for the previous answer and prepare output during the user's gesture", async () => {
	const { hook, player } = fixture();
	let finish!: () => void;
	player.play.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const one = answer("one"),
		two = answer("two");
	act(() => document.dispatchEvent(new Event("pointerdown")));
	expect(player.prepare).toHaveBeenCalledOnce();
	hook.rerender({ runs: [one.run], messages: [one.message], enabled: true });
	await waitFor(() => expect(player.play).toHaveBeenCalledOnce());
	hook.rerender({
		runs: [one.run, two.run],
		messages: [one.message, two.message],
		enabled: true,
	});
	expect(player.play).toHaveBeenCalledOnce();
	await act(async () => finish());
	await waitFor(() => expect(player.play).toHaveBeenCalledTimes(2));
});

test("a pending native answer finishes before the shared player reads another adopted answer", async () => {
	const { hook, player } = fixture();
	const next = answer("next");
	const props = {
		runs: [next.run],
		messages: [next.message],
		enabled: true,
		blocked: true,
	};
	hook.rerender(props);
	expect(player.play).not.toHaveBeenCalled();
	hook.rerender({ ...props, blocked: false });
	await waitFor(() => expect(player.play).toHaveBeenCalledOnce());
});

test("an answer adopted while muted is not deferred until the delayed message or unmute", () => {
	const { hook, player } = fixture();
	const muted = answer("muted");
	hook.rerender({ runs: [muted.run], messages: [], enabled: false });
	hook.rerender({
		runs: [muted.run],
		messages: [muted.message],
		enabled: true,
	});
	expect(player.play).not.toHaveBeenCalled();
});
