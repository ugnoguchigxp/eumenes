import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type ToolStatus = {
	ok: boolean;
	version: string | null;
	detail?: string;
};

export type DoctorReport = {
	runtime: {
		bun: string;
		node: ToolStatus;
		python3: ToolStatus;
	};
	tools: {
		oxlint: ToolStatus;
		s11tnext: ToolStatus;
	};
	storage: {
		dataBytes: number;
		verificationReportsBytes: number;
		artifactsPresent: boolean;
		dbExists: boolean;
		dbLockPresent: boolean;
		keyDirMode: string | null;
	};
};

function probeCommand(cmd: string[]): ToolStatus {
	try {
		const res = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
		const out = `${res.stdout.toString()}${res.stderr.toString()}`.trim();
		const firstLine = out.split("\n")[0]?.trim() || null;
		if (res.exitCode === 0) return { ok: true, version: firstLine };
		return {
			ok: false,
			version: null,
			detail: firstLine ?? `exit ${res.exitCode}`,
		};
	} catch (error) {
		return {
			ok: false,
			version: null,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

export function directorySize(path: string): number {
	if (!existsSync(path)) return 0;
	let total = 0;
	const stack = [path];
	while (stack.length) {
		const cur = stack.pop()!;
		let st;
		try {
			st = statSync(cur);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			let entries;
			try {
				entries = readdirSync(cur, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry.isSymbolicLink()) continue;
				stack.push(join(cur, entry.name));
			}
		} else if (st.isFile()) {
			total += st.size;
		}
	}
	return total;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function collectDoctorReport(
	root = resolve(import.meta.dir, ".."),
): DoctorReport {
	const dbPath = process.env.EUMENES_DB
		? resolve(process.env.EUMENES_DB)
		: join(root, "data/eumenes.sqlite3");
	const keyDir = process.env.EUMENES_KEY_DIR
		? resolve(process.env.EUMENES_KEY_DIR)
		: join(root, "data/keys");
	let keyDirMode: string | null = null;
	if (existsSync(keyDir)) {
		try {
			keyDirMode = (statSync(keyDir).mode & 0o777).toString(8).padStart(3, "0");
		} catch {
			keyDirMode = null;
		}
	}
	return {
		runtime: {
			bun: Bun.version,
			node: probeCommand(["node", "--version"]),
			python3: probeCommand(["python3", "--version"]),
		},
		tools: {
			oxlint: probeCommand([
				process.execPath,
				"x",
				"--bun",
				"oxlint",
				"--version",
			]),
			s11tnext: probeCommand([
				process.execPath,
				"x",
				"--bun",
				"s11tnext",
				"--version",
			]),
		},
		storage: {
			dataBytes: directorySize(join(root, "data")),
			verificationReportsBytes: directorySize(
				join(root, "verification-reports"),
			),
			artifactsPresent: existsSync(join(root, "artifacts")),
			dbExists: existsSync(dbPath),
			dbLockPresent: existsSync(`${dbPath}.owner.lock`),
			keyDirMode,
		},
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2).filter((arg) => arg !== "--");
	const report = collectDoctorReport();
	if (args.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`Eumenes doctor (read-only)`);
		console.log(`  bun      : ${report.runtime.bun}`);
		console.log(
			`  node     : ${report.runtime.node.ok ? report.runtime.node.version : `missing (${report.runtime.node.detail ?? "not in PATH"})`}`,
		);
		console.log(
			`  python3  : ${report.runtime.python3.ok ? report.runtime.python3.version : `missing (${report.runtime.python3.detail ?? "not in PATH"})`}`,
		);
		console.log(
			`  oxlint   : ${report.tools.oxlint.ok ? report.tools.oxlint.version : `failed (${report.tools.oxlint.detail})`}`,
		);
		console.log(
			`  s11tnext : ${report.tools.s11tnext.ok ? report.tools.s11tnext.version : `failed (${report.tools.s11tnext.detail})`}`,
		);
		console.log(`  data/    : ${formatBytes(report.storage.dataBytes)}`);
		console.log(
			`  reports/ : ${formatBytes(report.storage.verificationReportsBytes)}`,
		);
		console.log(
			`  db       : ${report.storage.dbExists ? "present" : "missing"}${report.storage.dbLockPresent ? " (owner lock present)" : ""}`,
		);
		console.log(`  keys dir : ${report.storage.keyDirMode ?? "missing"}`);
		console.log(
			`  artifacts: ${report.storage.artifactsPresent ? "present (excluded by .gitignore)" : "none"}`,
		);
	}
}
