// P0 only. The launcher applies its macOS profile before this process starts.
import { dlopen, FFIType, read } from "bun:ffi";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const [controls, stage, shared, output, compiler, forbidden, mode] =
	process.argv.slice(2);
// Bun is invoked from the fixture checkout, but all tools use the trusted directory.
process.chdir(controls);
const i32 = FFIType.i32;
const ptr = FFIType.ptr;
const libc = mode === "boundary" ? dlopen("/usr/lib/libSystem.B.dylib", {
	socket: { args: [i32, i32, i32], returns: i32 },
	connect: { args: [i32, ptr, i32], returns: i32 },
	close: { args: [i32], returns: i32 },
	__error: { args: [], returns: ptr },
}).symbols : null;
const denied = (operation: () => unknown) => {
	try {
		operation();
		return false;
	} catch (error) {
		return ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");
	}
};
if (mode === "boundary") {
	if (!libc) throw new Error("missing_boundary_probe");
	// Darwin's sockaddr_in for loopback port 1. Ask the kernel for the result;
	// Bun's JS TCP wrapper does not preserve the permission errno here.
	const inet = 2;
	const stream = 1;
	const loopback = Buffer.alloc(16);
	loopback[0] = loopback.length;
	loopback[1] = inet;
	loopback.writeUInt16BE(1, 2);
	loopback.set([127, 0, 0, 1], 4);
	const fd = libc.socket(inet, stream, 0);
	const connected = fd < 0 ? fd : libc.connect(fd, loopback, loopback.length);
	const errno = read.i32(libc.__error()!);
	if (fd >= 0) libc.close(fd);
	const networkDenied = connected === -1 && [1, 13].includes(errno);
	const readDenied = denied(() => readFileSync(forbidden, "utf8"));
	const writeDenied = denied(() => writeFileSync(resolve(stage, "unexpected"), "unexpected"));
	const sharedWriteDenied = denied(() =>
		writeFileSync(resolve(shared, "unexpected"), "unexpected"),
	);
	writeFileSync(resolve(output, "boundary-allowed"), "OK");
	console.log(JSON.stringify({
		readDenied, writeDenied, sharedWriteDenied, networkDenied,
		environmentClean: !process.env.WORKS_FIXTURE_SETTINGS && !process.env.WORKS_FIXTURE_HOST_ENV,
	}));
	process.exitCode = readDenied && writeDenied && sharedWriteDenied && networkDenied ? 0 : 1;
} else {
	const ts = require(resolve(compiler, "typescript.js")) as typeof import("typescript");
	const sources = readdirSync(stage).filter((name) => /\.tsx?$/.test(name))
		.map((name) => resolve(stage, name));
	for (const source of sources) {
		const parsed = ts.createSourceFile(source, readFileSync(source, "utf8"), ts.ScriptTarget.Latest, true);
		for (const node of parsed.statements) {
			if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
			if (node.attributes?.elements.some((attribute) => attribute.name.text === "type" &&
				ts.isStringLiteral(attribute.value) && attribute.value.text === "macro")) {
				console.log(JSON.stringify({ error: "macro_import_forbidden" }));
				process.exit(2);
			}
		}
	}
	const entry = resolve(stage, "main.tsx");
	if (mode === "typecheck" || mode === "build") {
		const config = ts.readConfigFile(resolve(controls, "typecheck.json"), ts.sys.readFile);
		if (config.error) throw new Error("invalid_typecheck_fixture");
		const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, stage);
		const program = ts.createProgram([entry], parsed.options);
		const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
			.map(({ code, messageText }) => ({ code, message: ts.flattenDiagnosticMessageText(messageText, " ") }));
		if (mode === "typecheck" || diagnostics.length) console.log(JSON.stringify({ diagnostics }));
		if (diagnostics.length) process.exit(3);
	}
	if (mode !== "typecheck") {
		const exports: Record<string, string> = JSON.parse(readFileSync(resolve(controls, "exports.json"), "utf8"));
		const build = await Bun.build({
			entrypoints: [entry],
			outdir: output,
			tsconfig: resolve(controls, "build-tsconfig.json"),
			target: "browser",
			minify: true,
			env: "disable",
			plugins: [{
				name: "fixture-shared-exports",
				setup(builder) {
					builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
						if (!importer.startsWith(stage + sep)) return;
						if (path.startsWith("./") || path.startsWith("../")) {
							if (!resolve(dirname(importer), path).startsWith(stage + sep))
								throw new Error("source_outside_snapshot");
							return;
						}
						if (!Object.hasOwn(exports, path)) throw new Error("unregistered_import");
						return { path: resolve(shared, exports[path]!) };
					});
				},
			}],
		});
		console.log(JSON.stringify({ built: build.success, outputs: build.outputs.length }));
		if (!build.success) process.exitCode = 4;
	}
}
