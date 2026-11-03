import { createMediaGateway } from "../../../infrastructure/media-gateway";
import { checkRefusal } from "../../larm";
import {
	acceptedJob,
	detectionResult,
	jobResult,
	type Connection,
} from "../contracts";
export function recognitionGateway(
	connection: Connection,
	fetcher: typeof fetch = fetch,
) {
	return createMediaGateway(
		connection,
		fetcher,
		"recognition",
		checkRefusal,
		(status, body) => {
			const parsed =
				status === 202
					? acceptedJob.safeParse(body)
					: detectionResult.safeParse(body);
			if (!parsed.success) throw new Error("recognition_invalid_response");
			return parsed.data;
		},
		(body, id) => {
			const parsed = jobResult.safeParse(body);
			if (!parsed.success || (parsed.data.id && parsed.data.id !== id))
				throw new Error("recognition_invalid_response");
			return parsed.data;
		},
	);
}
