import { useEffect, useState, type FormEvent } from "react";
import type { EumenesClient } from "../../../../client";
import type {
	PrototypeRegistration,
	TrialRequest,
} from "../../../../api/domains/prototype/contracts";
import { Button } from "../../design-system";

type TrialClient = Pick<EumenesClient, "prototypeTrialInventory">;

export function TrialForm({
	environment,
	busy,
	onRegister,
}: {
	environment: string;
	busy: boolean;
	onRegister(event: FormEvent, input: TrialRequest): void;
}) {
	return (
		<details>
			<summary>既存作品を試験導入</summary>
			<form
				className="works-forms"
				onSubmit={(event) => {
					const data = new FormData(event.currentTarget);
					const get = (key: string) => String(data.get(key) ?? "").trim();
					onRegister(event, {
						path: get("path"),
						name: get("name"),
						environment: get("environment"),
						entry: get("entry"),
						include: get("include")
							.split(/[,\n]/)
							.map((part) => part.trim())
							.filter(Boolean),
						mountId: get("mountId") || undefined,
					});
				}}
			>
				<label>
					作品のGitルート <input name="path" required />
				</label>
				<label>
					表示名 <input name="name" required maxLength={100} />
				</label>
				<label>
					共有環境の版{" "}
					<input name="environment" defaultValue={environment} required />
				</label>
				<label>
					入口ファイル{" "}
					<input name="entry" placeholder="src/main.tsx" required />
				</label>
				<label>
					ソースと素材（カンマ区切り）{" "}
					<input name="include" placeholder="src, assets" required />
				</label>
				<label>
					表示先の要素ID（任意） <input name="mountId" placeholder="root" />
				</label>
				<Button type="submit" disabled={busy}>
					試験導入
				</Button>
			</form>
		</details>
	);
}

export function TrialReport({
	client,
	work,
}: {
	client: TrialClient;
	work: PrototypeRegistration;
}) {
	const [report, setReport] =
		useState<Awaited<ReturnType<TrialClient["prototypeTrialInventory"]>>>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		let active = true;
		void client.prototypeTrialInventory(work.id).then(
			(next) => {
				if (active) setReport(next);
			},
			(problem: unknown) => {
				if (active)
					setError(
						problem instanceof Error ? problem.message : String(problem),
					);
			},
		);
		return () => {
			active = false;
		};
	}, [client, work.id]);
	return (
		<details open>
			<summary>試験導入の棚卸し</summary>
			<p>
				入口 {work.trial?.entry} ／ 共有環境 {work.trial?.environment}
			</p>
			{error && <p role="alert">{error}</p>}
			{report && (
				<dl>
					<dt>共有環境に未登録の依存</dt>
					<dd>{report.missing.join("、") || "なし"}</dd>
					<dt>宣言と共有環境の版の違い</dt>
					<dd>
						{report.versionDifferences
							.map(
								({ name, declared, shared }) =>
									`${name} ${declared} → ${shared}`,
							)
							.join("、") || "なし"}
					</dd>
					<dt>従来のコマンド</dt>
					<dd>
						{report.originalCommands.join("、") || "package.json の定義なし"}
					</dd>
					<dt>従来の設定ファイル</dt>
					<dd>{report.configuration.join("、") || "検出なし"}</dd>
					<dt>試験導入の対象外として見つかったファイル</dt>
					<dd>{report.unsupported.join("、") || "検出なし"}</dd>
				</dl>
			)}
		</details>
	);
}
