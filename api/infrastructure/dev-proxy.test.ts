import { expect, test } from "bun:test";
import { canonicalLoopbackRedirect, shouldAuthorize } from "./dev-proxy";

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

test("loopback alias redirects to the canonical origin", () => {
	expect(canonicalLoopbackRedirect("localhost:5173", "/x?y=1", expected)).toBe(
		"http://127.0.0.1:5173/x?y=1",
	);
	expect(
		canonicalLoopbackRedirect("127.0.0.1:5173", "/x", "http://localhost:5173"),
	).toBe("http://localhost:5173/x");
});

test("canonical host, other port, or foreign host is not redirected", () => {
	expect(canonicalLoopbackRedirect("127.0.0.1:5173", "/", expected)).toBeNull();
	expect(canonicalLoopbackRedirect("localhost:5174", "/", expected)).toBeNull();
	expect(
		canonicalLoopbackRedirect("evil.example:5173", "/", expected),
	).toBeNull();
	expect(canonicalLoopbackRedirect(undefined, "/", expected)).toBeNull();
});

test("protocol-relative or backslash paths are never redirected off-origin", () => {
	for (const url of [
		"//evil.example/x",
		"/\\evil.example/x",
		"///evil.example",
		"http://evil.example/",
		"evil",
		"",
	])
		expect(
			canonicalLoopbackRedirect("localhost:5173", url, expected),
		).toBeNull();
	expect(canonicalLoopbackRedirect("localhost:5173", "/a//b", expected)).toBe(
		"http://127.0.0.1:5173/a//b",
	);
});
