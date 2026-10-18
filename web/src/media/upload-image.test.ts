import { expect, it } from "vitest";
import type { EumenesClient } from "../../../client";
import { ApiError } from "../../../client/transport";
import { imageUploadMessage, settleImageImport } from "./upload-image";
const signal = new AbortController().signal;
it("queries the known UUID after response loss and never allocates another one", async () => {
	const id = crypto.randomUUID();
	const calls: string[] = [];
	const client = {
		imageImport: async (key: string) => {
			calls.push(key);
			return {
				status: "succeeded",
				artifact: { id: "artifact", width: 32, height: 32 },
			};
		},
	} as unknown as EumenesClient;
	const result = await settleImageImport(
		client,
		id,
		async () => {
			throw new TypeError("lost");
		},
		signal,
	);
	expect(calls).toEqual([id]);
	expect(result).toMatchObject({ status: "accepted", value: "artifact" });
});
it("failed receipts and deleted images stay distinct from uncertain results", async () => {
	const client = {} as EumenesClient;
	for (const [status, code] of [
		["failed", "storage_full"],
		["deleted", "image_import_artifact_deleted"],
		["expired", "image_import_receipt_expired"],
	] as const) {
		const result = await settleImageImport(
			client,
			crypto.randomUUID(),
			async () => ({
				requestId: crypto.randomUUID(),
				status,
				createdAt: 0,
				expiresAt: 1,
				retryAfterMs: 1000,
				errorCode: code,
			}),
			signal,
		);
		expect(result.status).toBe("rejected");
		expect(result.canRetry).toBe(status === "failed");
		expect(result.message).not.toContain("結果を確認できません");
	}
	const result = await settleImageImport(
		client,
		crypto.randomUUID(),
		async () => {
			throw new ApiError(415, "image_mime_mismatch");
		},
		signal,
	);
	expect(result).toMatchObject({ status: "rejected", canRetry: true });
});
it("HTTP categories remain distinct even when LARM returns a new error code", () => {
	const messages = [401, 409, 413, 415, 400, 429, 503, 507].map((status) =>
		imageUploadMessage("new_code", status),
	);
	expect(new Set(messages).size).toBe(8);
});

it("an unfamiliar failure code still reports a definite failed receipt", async () => {
	const result = await settleImageImport(
		{} as EumenesClient,
		crypto.randomUUID(),
		async () => ({
			requestId: crypto.randomUUID(),
			status: "failed",
			createdAt: 0,
			expiresAt: 1,
			retryAfterMs: 1000,
			errorCode: "new_failure",
			httpStatus: 200,
		}),
		signal,
	);
	expect(result.status).toBe("rejected");
	expect(result.message).toContain("失敗しました");
});
