import { expect, test } from "bun:test";
import { failureComparison } from "./steward-input-repeat-stats";

test("Fisher enumeration matches the documented 6/8 versus 1/5 example", () => {
	const r = failureComparison(6, 8, 1, 5);
	expect(r.candidateWorseP).toBeCloseTo(0.08624708624708625, 12);
	expect(r.twoSidedP).toBeCloseTo(0.10256410256410256, 12);
});

test("identical all-success samples do not show an effect or prove equivalence", () => {
	const r = failureComparison(0, 20, 0, 20);
	expect(r.candidateWorseP).toBeCloseTo(1, 12);
	expect(r.failureRateDifference).toBe(0);
});

test("directional evidence distinguishes frequent candidate failures from equal failures", () => {
	expect(failureComparison(10, 20, 0, 20).candidateWorseP).toBeLessThan(0.001);
	expect(failureComparison(0, 20, 10, 20).candidateWorseP).toBeCloseTo(1, 12);
	expect(() => failureComparison(21, 20, 0, 20)).toThrow("invalid_count");
});
