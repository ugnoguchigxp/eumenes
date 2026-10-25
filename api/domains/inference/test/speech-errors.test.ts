import { expect, test } from "bun:test";
import { isRetryableSpeechError } from "..";

test.each([
	"network_unavailable",
	"local_timeout",
	"larm_connect_timeout",
	"larm_inference_500",
	"cloud_http_503",
	"workers_ai_http_429",
	"workers_ai_http_502",
])("speech retries a temporary failure: %s", (code) => {
	expect(isRetryableSpeechError(new Error(code))).toBe(true);
});

test.each([
	"workers_ai_http_400",
	"larm_unconfigured",
	"larm_base_url_unconfigured",
	"cloud_http_401",
	"larm_inference_403",
	"larm_inference_413",
	"larm_inference_422",
	"workers_ai_schema_unsupported",
	"workers_ai_option_invalid",
	"invalid_tts_audio",
	"permission_revoked",
	"cancelled",
	"unknown_failure",
])("speech does not replay a permanent or unclassified failure: %s", (code) => {
	expect(isRetryableSpeechError(new Error(code))).toBe(false);
});

test("a transport timeout retries but caller cancellation never does", () => {
	expect(
		isRetryableSpeechError(new DOMException("deadline", "TimeoutError")),
	).toBe(true);
	expect(
		isRetryableSpeechError(new DOMException("cancelled", "AbortError")),
	).toBe(false);
});
