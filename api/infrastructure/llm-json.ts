import {
	decodeLlmJson as decode,
	LlmJsonError,
} from "eumenes-interact/llm-json";
import { getLogger } from "./logger";

export { LlmJsonError };

const log = getLogger("llm-json");

export function decodeLlmJson(input: unknown, limit = 65536) {
	try {
		const result = decode(input, limit);
		if (result.repaired && typeof input === "string")
			log.debug("llm_json.corrected", {
				bytes: Buffer.byteLength(input),
				reason: "syntax",
			});
		return result;
	} catch (error) {
		if (error instanceof LlmJsonError)
			log.debug("llm_json.rejected", {
				reason: error.code,
				bytes: typeof input === "string" ? Buffer.byteLength(input) : undefined,
				limit,
			});
		throw error;
	}
}

export const parseLlmJson = (input: unknown, limit?: number): unknown =>
	decodeLlmJson(input, limit).value;
