import { expect, test } from "vitest";
import { ApiError } from "../../../../../client";
import {
	CLAIM_TONES,
	FORGET_DISPLAYS,
	claimTone,
} from "../../../../../api/domains/world/contracts/view";
import { contentText, failureOf, forgetLabels, toneLabels } from "../present";

test("only an adopted report or document has the confirmed tone", () => {
	expect(claimTone("adopted", "user_report", ["user_statement"])).toBe(
		"adopted",
	);
	expect(claimTone("adopted", "document_claim", ["document"])).toBe("adopted");
	// A hypothesis stays a hypothesis even when adopted; a measurement is its own tone.
	expect(claimTone("adopted", "model_hypothesis", ["assistant_summary"])).toBe(
		"hypothesis",
	);
	expect(claimTone("adopted", "runtime_observation", [])).toBe("measured");
	expect(claimTone("adopted", "user_report", ["runtime_measurement"])).toBe(
		"measured",
	);
	// An unadopted claim is a candidate whatever its origin.
	for (const origin of [
		"user_report",
		"model_hypothesis",
		"runtime_observation",
	] as const)
		expect(claimTone("candidate", origin, [])).toBe("candidate");
	expect(claimTone("disputed", "user_report", [])).toBe("disputed");
	// Every tone has its own words.
	expect(new Set(CLAIM_TONES.map((t) => toneLabels[t])).size).toBe(
		CLAIM_TONES.length,
	);
});

test("only a complete forget reads as done", () => {
	const done = FORGET_DISPLAYS.filter((d) => forgetLabels[d] === "完了");
	expect(done).toEqual(["complete"]);
	for (const d of FORGET_DISPLAYS)
		if (d !== "complete")
			expect(forgetLabels[d]).toContain("完了ではありません");
});

test("values are shown as the person would read them", () => {
	expect(
		contentText({ kind: "value", value: { kind: "boolean", value: true } }),
	).toBe("はい");
	expect(
		contentText({
			kind: "value",
			value: { kind: "number", value: 120, unit: "ms" },
		}),
	).toBe("120 ms");
	expect(
		contentText({ kind: "relation", relation: "causes", objectId: "x" }),
	).toBe("causes → x");
});

test("a conflict asks for a reload; a hidden target is just not found", () => {
	expect(failureOf(new ApiError(409, "revision_conflict"))).toMatchObject({
		reload: true,
	});
	expect(failureOf(new ApiError(404, "not_found")).message).not.toMatch(
		/権限|許可|隠|存在する/,
	);
	expect(failureOf(new ApiError(404, "not_found")).reload).toBe(true);
	expect(failureOf(new Error("offline")).reload).toBe(false);
});
