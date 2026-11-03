import { createMediaGateway } from "../../../infrastructure/media-gateway";
import { checkRefusal } from "../../larm";
import {
	acceptedJob,
	ocrResult,
	jobResult,
	type Connection,
} from "../contracts";
export function ocrGateway(
	connection: Connection,
	fetcher: typeof fetch = fetch,
) {
	return createMediaGateway(
		connection,
		fetcher,
		"ocr",
		checkRefusal,
		(status, body) => {
			const parsed =
				status === 202
					? acceptedJob.safeParse(body)
					: ocrResult.safeParse(body);
			if (!parsed.success) throw new Error("ocr_invalid_response");
			return parsed.data;
		},
		(body, id) => {
			const parsed = jobResult.safeParse(body);
			if (!parsed.success || (parsed.data.id && parsed.data.id !== id))
				throw new Error("ocr_invalid_response");
			return parsed.data;
		},
	);
}
