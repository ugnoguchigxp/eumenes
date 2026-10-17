import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildSystemPrompt } from "../service/system-prompt";

// Reviewed TTS instruction fingerprints: preserve persona, names and literal
// placeholder-like input through the TOML compiler.
const cases = [
	{
		input: {
			persona: "butler",
			agentName: "",
			userName: "",
		},
		sha256: "e7d92c6d6b267768ab2636d65041bb699fbe072a6201f16be1a3b7a24ca1b4ca",
	},
	{
		input: {
			persona: "butler",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "3e968ef732c8963a28c9a58ea1f66fa3b12dcb00d9746bfe868c72bb1fb64b6e",
	},
	{
		input: {
			persona: "butler",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "cafe51714e1a0bbbb3cfdbf9ae637bc98e96122b38b15e295f794184106cf601",
	},
	{
		input: {
			persona: "maid",
			agentName: "",
			userName: "",
		},
		sha256: "14e6d83865ce98c8af05fcb7c049bd5abc2a2c13e0b66a98441c04119b2525b9",
	},
	{
		input: {
			persona: "maid",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "095b1ed9a5a8992e56c77d757d5a2a1eea38abcaf0fd3c6b81673f672d62bdbb",
	},
	{
		input: {
			persona: "maid",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "a42db593d46c43f9f78a887f1cdb6f2981c1897c173f05609a1c695fc319be7a",
	},
	{
		input: {
			persona: "strategist",
			agentName: "",
			userName: "",
		},
		sha256: "ff356f92a04d24620628d301fd9352d4596a3b7d15ae72e6ca3d397ca4018efd",
	},
	{
		input: {
			persona: "strategist",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "cc0ba359f233c15f1f8136ca73c4adc41ae7331bebb879c6b757603d9b969770",
	},
	{
		input: {
			persona: "strategist",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "f5704dc830c37937cd19903357291eed967d933edeca1e9de6f0e90c88cefcd0",
	},
	{
		input: {
			persona: "sage",
			agentName: "",
			userName: "",
		},
		sha256: "9a3b4dbdd5e88706bb7eb33f88b730c812eccd547c3f92ddeea8cbb146f78913",
	},
	{
		input: {
			persona: "sage",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "6f852e0ce58142ba35631237586610d8f7334db031176e6eacfef0adc480b382",
	},
	{
		input: {
			persona: "sage",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "247856633defbd497adc07d24b0d2b33dd360204aa1a5f4372ea87e2f2314f0b",
	},
] as const;

test("TOML preserves the conversation instruction bytes for every persona", () => {
	for (const { input, sha256 } of cases) {
		const text = buildSystemPrompt(input);
		expect(createHash("sha256").update(text).digest("hex")).toBe(sha256);
	}
});
