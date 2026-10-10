import { expect, test } from "bun:test";
import { shouldAuthorize } from "./dev-proxy";

const expected = "http://127.0.0.1:5173";

test("matching Origin is authorized", () => {
	expect(shouldAuthorize({ origin: expected }, expected)).toBe(true);
});

test("other Origin is not authorized", () => {
	expect(shouldAuthorize({ origin: "http://evil.example" }, expected)).toBe(
		false,
	);
});

test("no Origin with same-origin fetch metadata is authorized", () => {
	expect(shouldAuthorize({ "sec-fetch-site": "same-origin" }, expected)).toBe(
		true,
	);
});

test("no Origin with cross-site fetch metadata is not authorized", () => {
	expect(shouldAuthorize({ "sec-fetch-site": "cross-site" }, expected)).toBe(
		false,
	);
});

test("no Origin and no fetch metadata (curl) is not authorized", () => {
	expect(shouldAuthorize({}, expected)).toBe(false);
});
