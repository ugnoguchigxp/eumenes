import { expect, test } from "bun:test";
import { errorLabel } from "../contracts";

test("every code a task or tab can end with has its own Japanese label", () => {
	const generic = errorLabel("something_unknown");
	for (const code of [
		"turn_limit",
		"invalid_contract",
		"invoke_on_last_call",
		"tool_refused",
		"observation_budget_exceeded",
		"capability_unavailable",
		"permission_revoked",
		"approval_required",
		"tab_blocked",
		"navigation_invalid_url",
		"navigation_scheme_blocked",
		"navigation_credentials_blocked",
		"navigation_private_blocked",
		"navigation_api_blocked",
		"navigation_unresolved_blocked",
	]) {
		const label = errorLabel(code);
		expect(label).not.toBe(generic);
		expect(label).toMatch(/[ぁ-んァ-ン一-龥]/);
	}
	expect(errorLabel(null)).toBeNull();
});
