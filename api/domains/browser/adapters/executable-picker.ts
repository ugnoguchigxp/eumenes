import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ExecutablePicker } from "../contracts/ports";

const DIALOG_MS = 5 * 60_000;
const SCRIPT = [
	"activate",
	'POSIX path of (choose file with prompt "Braveを選んでください" default location (path to applications folder))',
];
/** AppleScript's "user canceled" error; any other failure is reported, not taken as a cancel. */
const CANCELED = "(-128)";

/** The macOS file dialog; undefined elsewhere, where the path is typed in. */
export function createExecutablePicker(): ExecutablePicker | undefined {
	if (process.platform !== "darwin") return undefined;
	return async () => {
		const dialog = await run(
			"osascript",
			SCRIPT.flatMap((line) => ["-e", line]),
			DIALOG_MS,
		);
		if (dialog.code !== 0) {
			if (dialog.err.includes(CANCELED)) return null;
			throw new Error("browser_browse_failed");
		}
		const path = dialog.out.replace(/\/$/, "");
		if (!path.endsWith(".app")) return path;
		// An app bundle names its executable in Info.plist.
		const plist = await run(
			"plutil",
			[
				"-extract",
				"CFBundleExecutable",
				"raw",
				"-o",
				"-",
				join(path, "Contents", "Info.plist"),
			],
			5_000,
		);
		const name = plist.out;
		if (plist.code !== 0 || !name || name.includes("/"))
			throw new Error("browser_executable_invalid");
		return join(path, "Contents", "MacOS", name);
	};
}

/** Exit code (null when it could not run or was killed), stdout without the trailing newline, and stderr. */
function run(command: string, args: string[], timeoutMs: number) {
	return new Promise<{ code: number | null; out: string; err: string }>(
		(resolve) => {
			const child = spawn(command, args, {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			let err = "";
			const timer = setTimeout(() => child.kill(), timeoutMs);
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				out += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				err += chunk;
			});
			child.on("error", () => {
				clearTimeout(timer);
				resolve({ code: null, out: "", err });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ code, out: out.replace(/\n$/, ""), err });
			});
		},
	);
}
