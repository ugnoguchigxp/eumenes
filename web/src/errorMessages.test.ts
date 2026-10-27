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

test("snake_case codes are shown as a code; English text is not", () => {
	expect(describeError(new ApiError(500, "weird_code"))).toBe(
		"エラーが発生しました(コード: weird_code)",
	);
	expect(describeError(new Error("ApiError: voice_x"))).toContain("voice_x");
	expect(describeError(new Error("larm_inference_409"))).toBe(
		"エラーが発生しました(コード: larm_inference_409)",
	);
	expect(describeError(new Error("Failed to fetch resource"))).toBe(
		"エラーが発生しました。",
	);
	expect(describeError(new ApiError(500, "Internal Server Error"))).toBe(
		"エラーが発生しました。",
	);
	expect(describeError(undefined)).toBe("エラーが発生しました。");
});

test("connection errors and statuses are translated", () => {
	expect(describeError(new ApiConnectionError())).toContain("接続できません");
	expect(describeTurnStatus("synthesizing")).toBe("音声を合成中");
	expect(describeTurnStatus("new")).toBe("状態を確認中");
	expect(describeConnectionState("ready")).toBe("接続済み");
	expect(describeConnectionState("new")).toBe("状態を確認中");
});

test("DOMException names map to microphone messages", () => {
	const name = (n: string) => describeError(new DOMException("raw text", n));
	expect(name("NotAllowedError")).toContain("許可されていません");
	expect(name("NotFoundError")).toBe("マイクが見つかりません。");
	expect(name("NotReadableError")).toContain("使用中");
	expect(name("OverconstrainedError")).toContain("使えません");
	expect(name("AbortError")).toBe("操作が中断されました。");
	expect(name("SomethingElse")).toBe("エラーが発生しました。");
});

test.each([["speech_tts_target_unavailable", "声を利用できません"]])(
	"speech routing failure %s explains why audio stopped",
	(code, message) => {
		expect(describeError(new Error(code))).toContain(message);
		expect(describeError(new Error(code))).not.toContain(code);
	},
);
