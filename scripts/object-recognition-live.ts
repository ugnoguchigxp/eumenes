import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadProcessConfig } from "../api/infrastructure/config";
import { readApiToken } from "../api/infrastructure/auth-config";
import { readStoredObjectRecognitionConnection } from "../api/domains/settings";
import { createClient } from "../client";
const config = loadProcessConfig();
const dbPath = resolve(config.dbPath);
const connection = existsSync(dbPath)
	? readStoredObjectRecognitionConnection(dbPath)
	: { configured: false, formalDeployment: "unconfirmed", baseUrl: null };
const report: Record<string, unknown> = {
	at: new Date().toISOString(),
	connection,
	fixture: false,
	live: "not_run",
	camera: "not_run",
};
const fileIndex = process.argv.indexOf("--file");
if (fileIndex >= 0) {
	if (!connection.configured)
		report.reason = "backend_object_recognition_connection_not_configured";
	else {
		try {
			const client = createClient(
				`http://127.0.0.1:${config.port}`,
				readApiToken(process.env),
			);
			const status = await client.recognitionConnection();
			if (!status.credentialConfigured)
				throw new Error("recognition_not_configured");
			const file = Bun.file(resolve(process.argv[fileIndex + 1]!));
			const record = await client.recognitionUpload(
				new File([await file.arrayBuffer()], file.name!.split("/").at(-1)!, {
					type: file.type,
				}),
				"main",
				crypto.randomUUID(),
			);
			let current = record;
			for (
				let i = 0;
				i < 180 &&
				["queued", "starting", "running", "cancelling"].includes(current.state);
				i++
			) {
				await Bun.sleep(1000);
				current = await client.recognitionGet(record.id);
			}
			report.live = current.state === "completed" ? "passed" : "failed";
			report.id = current.id;
			report.state = current.state;
			report.errorCode = current.errorCode;
			if (current.state === "completed") {
				report.sourceBytes = (await client.recognitionContent(current.id)).size;
				report.kind = current.result?.kind;
				report.model = current.result?.model;
				report.frameCount =
					current.result?.kind === "video"
						? current.result.frames.length
						: null;
			}
		} catch {
			report.live = "unavailable";
			report.reason = "backend_live_connection_unavailable";
		}
	}
} else
	report.reason = connection.configured
		? "read_only_check_no_analysis_requested"
		: "backend_object_recognition_connection_not_configured";
mkdirSync("spec/verification/object-recognition-2026-10-13", {
	recursive: true,
});
writeFileSync(
	"spec/verification/object-recognition-2026-10-13/live-readiness.json",
	JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
