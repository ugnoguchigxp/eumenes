import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Message } from "../../../api/domains/conversation/contracts";
import { useAnswerAvatarCue } from "./useAnswerAvatarCue";

function answer(id: string, emotionConfidence = 0.9): Message {
	return {
		id,
		role: "assistant",
		text: "よかったですね。",
		conversationId: "main",
		createdAt: "2026-11-12T00:00:00Z",
		runId: null,
		delivery: {
			id: crypto.randomUUID(),
			version: 2,
			emotion: "joy",
			emotionConfidence,
			motion: "joyful",
			tone: "bright",
			source: "system-one",
			confidence: emotionConfidence,
			latencyMs: 10,
		},
	};
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

test("expresses a new answer once and expires through a history refresh", () => {
	vi.useFakeTimers();
	const old = answer("history");
	const next = answer("new");
	const { result, rerender } = renderHook(
		({ messages }) => useAnswerAvatarCue(messages, false),
		{ initialProps: { messages: [old] } },
	);
	expect(result.current).toBeNull();
	rerender({ messages: [old, next] });
	expect(result.current).toMatchObject({
		key: "message:new",
		emotion: "joy",
		motion: "joyful",
	});
	act(() => vi.advanceTimersByTime(2000));
	rerender({ messages: [old, { ...next }] });
	expect(result.current?.emotion).toBe("joy");
	act(() => vi.advanceTimersByTime(700));
	expect(result.current).toBeNull();
	rerender({ messages: [old] });
	rerender({ messages: [old, next] });
	expect(result.current).toBeNull();
});

test("playback takes precedence without replaying deferred or uncertain messages", () => {
	const old = answer("history");
	const { result, rerender } = renderHook(
		({ messages, blocked }) => useAnswerAvatarCue(messages, blocked),
		{ initialProps: { messages: [old], blocked: false } },
	);
	const visible = [old, answer("new")];
	rerender({ messages: visible, blocked: false });
	expect(result.current?.motion).toBe("joyful");
	rerender({ messages: visible, blocked: true });
	expect(result.current).toBeNull();
	const duringPlayback = [...visible, answer("during-playback")];
	rerender({ messages: duringPlayback, blocked: true });
	rerender({ messages: duringPlayback, blocked: false });
	expect(result.current).toBeNull();
	const uncertain = [...duringPlayback, answer("uncertain", 0.2)];
	rerender({ messages: uncertain, blocked: false });
	expect(result.current).toBeNull();
});
