import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	generatedImagesMigration,
	hasImageObservations,
	saveImageObservation,
} from "../repository/generated-images";

test("hasImageObservations answers per conversation with one EXISTS, whatever the observation's state", () => {
	const db = new Database(":memory:");
	db.exec(generatedImagesMigration.sql);
	expect(hasImageObservations(db, "main")).toBe(false);
	saveImageObservation(db, {
		workId: "w1",
		conversationId: "main",
		revision: 1,
		originDigest: "d",
		images: [],
		state: "pending",
	});
	expect(hasImageObservations(db, "main")).toBe(true);
	expect(hasImageObservations(db, "other")).toBe(false);
});
