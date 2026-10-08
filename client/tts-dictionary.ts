import {
	entriesSchema,
	type DeleteInput,
	type Entry,
	type SaveInput,
} from "../api/domains/tts-dictionary/contracts";
import { json, type Transport } from "./transport";
export function ttsDictionaryClient(t: Transport) {
	const entries = async (response: Response): Promise<Entry[]> =>
		entriesSchema.parse(await response.json()).entries;
	return {
		ttsDictionary: async () => entries(await t.call("/api/tts-dictionary")),
		saveTtsDictionaryEntry: async (input: SaveInput) =>
			entries(await t.call("/api/tts-dictionary/save", json(input))),
		deleteTtsDictionaryEntry: async (input: DeleteInput) =>
			entries(await t.call("/api/tts-dictionary/delete", json(input))),
	};
}
