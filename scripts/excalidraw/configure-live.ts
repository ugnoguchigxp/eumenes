import {
	constants,
	openSync,
	fstatSync,
	readFileSync,
	closeSync,
} from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import {
	readApiToken,
	resolveLarmToken,
} from "../../api/infrastructure/auth-config";
import { excalidrawConnectionInput } from "../../api/domains/settings/contracts";
import { createClient } from "../../client";

/** Accept the agreed LARM handoff through the existing encrypted settings API. */
async function main() {
	const args = process.argv.slice(2);
	const path = args.find((arg) => !arg.startsWith("--"));
	if (
		!path ||
		args.some((arg) => arg.startsWith("--") && arg !== "--apply") ||
		args.filter((arg) => !arg.startsWith("--")).length !== 1
	)
		throw new Error(
			"usage: bun scripts/excalidraw/configure-live.ts <private-json-file> [--apply]",
		);
	const file = resolve(path),
		repository = resolve(import.meta.dir, "../..");
	const fromRepository = relative(repository, file);
	if (!fromRepository.startsWith("../") && !isAbsolute(fromRepository))
		throw new Error("handoff_must_be_outside_repository");
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	let raw: string;
	try {
		const info = fstatSync(fd);
		if (
			!info.isFile() ||
			info.size > 16384 ||
			info.mode & 0o077 ||
			(process.getuid && info.uid !== process.getuid())
		)
			throw new Error("private_handoff_file_required");
		raw = readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
	const schema = excalidrawConnectionInput
		.omit({ expectedRevision: true })
		.extend({
			consumerToken: z.string().min(32).max(4096),
			appToken: z.string().min(32).max(4096),
		});
	const parsed = schema.safeParse(JSON.parse(raw));
	if (!parsed.success) throw new Error("invalid_excalidraw_handoff");
	const input = parsed.data;
	if (
		input.consumerToken === input.appToken ||
		[input.consumerToken, input.appToken].includes(
			resolveLarmToken(process.env) ?? "",
		)
	)
		throw new Error("dedicated_credential_roles_required");
	if (!args.includes("--apply")) {
		console.log(
			JSON.stringify({
				inputValid: true,
				settingsWritten: false,
				connectionVerified: false,
			}),
		);
		return;
	}
	const client = createClient(
		process.env.EUMENES_API_URL || "http://127.0.0.1:8787",
		readApiToken(process.env),
	);
	const current = await client.excalidrawConnection();
	await client.configureExcalidraw({
		...input,
		expectedRevision: current.revision,
	});
	console.log(
		JSON.stringify({
			inputValid: true,
			settingsWritten: true,
			connectionVerified: false,
		}),
	);
}
// Never print schema issues, file contents, credentials or transport error details.
await main().catch(() => {
	console.error(
		"excalidraw_configuration_failed: check arguments, private handoff file and backend API",
	);
	process.exitCode = 1;
});
