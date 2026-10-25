import { expect, test } from "bun:test";
import { chatRequest } from "../service/chat-request";

test("native decisions keep the compatible auto choice at temperature zero without forcing JSON output", () => {
	const tools = [
		{
			type: "function" as const,
			function: {
				name: "choose",
				description: "Select",
				parameters: { type: "object" },
			},
		},
	];
	const request = chatRequest(
		{ model: "fixture", contextWindow: { outputReserveTokens: 4096 } },
		[{ role: "user", content: "fixture" }],
		true,
		{ tools },
	);
	expect(request).toMatchObject({
		tools,
		tool_choice: "auto",
		parallel_tool_calls: false,
		temperature: 0,
	});
	expect(request).not.toHaveProperty("response_format");
	// A call whose only valid output is a function call asks the provider for one.
	expect(
		chatRequest(
			{ model: "fixture", contextWindow: { outputReserveTokens: 4096 } },
			[{ role: "user", content: "fixture" }],
			true,
			{ tools, toolChoice: "required" },
		),
	).toMatchObject({ tools, tool_choice: "required" });
	// A spoken reply offered tools decides on them greedily as well.
	expect(
		chatRequest(
			{ model: "fixture", contextWindow: { outputReserveTokens: 4096 } },
			[{ role: "user", content: "fixture" }],
			true,
			{ tools },
		),
	).toMatchObject({ temperature: 0 });
	expect(
		chatRequest(
			{ model: "fixture", contextWindow: { outputReserveTokens: 4096 } },
			[],
			true,
		),
	).not.toHaveProperty("temperature");
});
