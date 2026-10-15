import { request } from "node:http";
import type {
	SdkActivity,
	SdkReceipt,
	SdkRequest,
	SdkSpec,
} from "./sdk-contracts";
import { sdkReceiptSchema, sdkEventsSchema, sdkListSchema } from "./sdk-schema";

/** Private Unix socket API; neither this client nor the CLI opens the product DB. */
export function sdkRunnerClient(socket: string) {
	function call<T>(input: SdkRequest): Promise<T> {
		return new Promise((resolve, reject) => {
			const body = JSON.stringify(input);
			const req = request(
				{
					socketPath: socket,
					path: "/sdk",
					method: "POST",
					headers: {
						"content-type": "application/json",
						"content-length": Buffer.byteLength(body),
					},
					timeout: 5000,
				},
				(res) => {
					let data = "";
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						data += chunk;
						if (data.length > 2 * 1024 * 1024)
							req.destroy(new Error("sdk_response_limit"));
					});
					res.on("end", () => {
						try {
							const value = JSON.parse(data);
							if (res.statusCode !== 200)
								reject(new Error(value.code ?? "sdk_runner_rejected"));
							else resolve(value);
						} catch {
							reject(new Error("sdk_response_invalid"));
						}
					});
				},
			);
			req.on("timeout", () => req.destroy(new Error("sdk_runner_timeout")));
			req.on("error", () => reject(new Error("sdk_runner_unavailable")));
			req.end(body);
		});
	}
	return {
		list: () =>
			call<{
				executions: Array<
					Pick<
						SdkReceipt,
						| "executionId"
						| "ownerId"
						| "workspaceId"
						| "state"
						| "threadId"
						| "updatedAt"
					>
				>;
			}>({ operation: "list" }).then((value) => sdkListSchema.parse(value)),
		start: (spec: SdkSpec) =>
			call<SdkReceipt>({ operation: "start", spec }).then((value) =>
				sdkReceiptSchema.parse(value),
			),
		inspect: (executionId: string) =>
			call<SdkReceipt>({ operation: "inspect", executionId }).then((value) =>
				sdkReceiptSchema.parse(value),
			),
		events: (executionId: string, after = 0, limit = 100) =>
			call<{ receipt: SdkReceipt; events: SdkActivity[] }>({
				operation: "events",
				executionId,
				after,
				limit,
			}).then((value) => sdkEventsSchema.parse(value)),
		stop: (executionId: string, operationId: string) =>
			call<SdkReceipt>({ operation: "stop", executionId, operationId }).then(
				(value) => sdkReceiptSchema.parse(value),
			),
		release: (executionId: string, operationId: string) =>
			call<SdkReceipt>({ operation: "release", executionId, operationId }).then(
				(value) => sdkReceiptSchema.parse(value),
			),
		recover: (executionId: string) =>
			call<SdkReceipt>({ operation: "recover", executionId }).then((value) =>
				sdkReceiptSchema.parse(value),
			),
	};
}
