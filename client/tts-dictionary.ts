import {
	entriesSchema,
	type DeleteInput,
	type SaveInput,
} from "../api/domains/tts-dictionary/contracts";
import { callJson, json, type Transport } from "./transport";
export function ttsDictionaryClient(t: Transport) {
	return {
		ttsDictionary: async () =>
			(await callJson(t, entriesSchema, "/api/tts-dictionary")).entries,
		saveTtsDictionaryEntry: async (input: SaveInput) =>
			(
				await callJson(
					t,
					entriesSchema,
					"/api/tts-dictionary/save",
					json(input),
				)
			).entries,
		deleteTtsDictionaryEntry: async (input: DeleteInput) =>
			(
				await callJson(
					t,
					entriesSchema,
					"/api/tts-dictionary/delete",
					json(input),
				)
			).entries,
	};
}
