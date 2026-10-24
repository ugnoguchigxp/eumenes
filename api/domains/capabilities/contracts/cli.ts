import { z } from "zod";

/** One CLI command; interpretation stays with the command specialist. */
export const cliRun = z.strictObject({
	command: z
		.string()
		.trim()
		.min(1)
		.max(8000)
		.regex(
			// eslint-disable-next-line no-control-regex -- Only newline and tab are permitted control characters.
			/^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]*$/,
			"shell_command_invalid",
		)
		.describe(
			"登録されたプロジェクトで実行するシェルコマンド。秘密を含めない。",
		),
	task: z.string().trim().min(1).max(40).describe("利用者に伝える短いタスク名"),
	timeoutSeconds: z
		.number()
		.int()
		.min(1)
		.max(600)
		.optional()
		.describe("実行期限の秒数（既定120、最大600）"),
});
