import { expect, test } from "bun:test";
import { hash } from "../../capabilities";
import { coordinationScopes } from "../decisions";
import { proposal } from "./fixture";

test("the planner sees current and follow-up file scopes in the checkout without receiving the other conversation's instructions", () => {
	const writer = proposal("edit");
	const next = { ...proposal("verify"), mode: "verify" as const };
	const reader = proposal("read", "read first", { verification: next });
	const scopes = coordinationScopes([
		{ id: "editor", state: "running", proposal: writer },
		{ id: "reader", state: "waiting", proposal: reader },
		{ id: "finished", state: "finished", proposal: writer },
	]);
	expect(scopes.map(({ taskId }) => taskId)).toEqual(["editor", "reader"]);
	expect(scopes[0]).toMatchObject({
		writablePaths: writer.writablePaths,
		mode: "edit",
	});
	expect(scopes[1]?.verification).toEqual({
		mode: "verify",
		readablePaths: next.readablePaths,
		writablePaths: [],
		checks: next.checks.map((check) => ({
			cwd: check.cwd,
			digest: hash(check),
		})),
	});
	expect(JSON.stringify(scopes)).not.toContain(writer.authorityQuote);
});
