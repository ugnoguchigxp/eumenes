import { expect, test } from "vitest";
import { ApiConnectionError, ApiError } from "../../client/transport";
import {
	describeConnectionState,
	describeError,
	describeTurnStatus,
} from "./errorMessages";

test("known API codes become Japanese sentences", () => {
	expect(describeError(new ApiError(409, "request_conflict"))).toContain(
		"画面を更新",
	);
	expect(
		describeError(new ApiError(503, "database_writer_queue_full")),
	).toContain("混み合って");
	expect(describeError(new Error("mic_lost"))).toContain("マイク");
});

test("unknown codes keep the code in parentheses", () => {
	expect(describeError(new ApiError(500, "weird_code"))).toBe(
		"エラーが発生しました(weird_code)",
	);
	expect(describeError(new Error("ApiError: voice_x"))).toContain("voice_x");
	expect(describeError(undefined)).toBe("エラーが発生しました。");
});

test("connection errors and statuses are translated", () => {
	expect(describeError(new ApiConnectionError())).toContain("接続できません");
	expect(describeTurnStatus("synthesizing")).toBe("音声を合成中");
	expect(describeTurnStatus("new")).toBe("new");
	expect(describeConnectionState("ready")).toBe("接続済み");
});
