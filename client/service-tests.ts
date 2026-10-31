import { uploadedSchema } from "../api/domains/service-tests/contracts";
import { callJson, type Transport } from "./transport";
export function serviceTestsClient(t: Transport) {
	const root = "/api/service-tests";
	return {
		uploadTestAudio: async (file: Blob) =>
			callJson(t, uploadedSchema, `${root}/uploads`, {
				method: "POST",
				body: file,
			}),
	};
}
