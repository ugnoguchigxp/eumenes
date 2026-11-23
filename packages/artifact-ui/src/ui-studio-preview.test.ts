import { expect, test } from "bun:test";
import { workflowFormValues } from "./ui-studio-preview";
import type { FormResource } from "./contracts";

test("workflow submission keeps typed numbers, choices and booleans and omits optional blanks", () => {
	const form: FormResource = {
		kind: "form",
		revision: 1,
		fields: [
			{ id: "count", label: "個数", type: "number", required: true },
			{ id: "tags", label: "選択", type: "checkbox", options: ["a", "b"] },
			{ id: "flag", label: "可否", type: "boolean" },
			{ id: "note", label: "メモ", type: "text" },
		],
		defaults: {},
	};
	expect(
		workflowFormValues(
			form,
			{ count: "amount", tags: "choices", flag: "enabled", note: "memo" },
			{
				count: "12",
				tags: '["a","b"]',
				flag: false,
				note: "",
				extra: "ignored",
			},
		),
	).toEqual({ amount: 12, choices: ["a", "b"], enabled: false });
	expect(workflowFormValues(form, { count: "amount" }, { count: "" })).toEqual({
		amount: "",
	});
});
