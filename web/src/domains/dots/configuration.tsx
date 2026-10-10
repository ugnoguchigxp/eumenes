import { useState } from "react";
import type { z } from "zod";
import type {
	Connection,
	Project,
	connectionInput,
	projectInput,
} from "../../../../api/domains/dots/contracts";
import type { EumenesClient } from "../../../../client";
export const operationLabels = {
	read: "参照",
	create_session: "新しいSession",
	continue_session: "既存Sessionの続行",
	edit: "編集",
	check: "検証",
	commit: "コミット",
	push: "プッシュ",
	publish: "公開",
	send: "外部への送信",
};
type Pack = Awaited<ReturnType<EumenesClient["dotsPackages"]>>["items"][number];
export function ConnectionEditor({
	value,
	busy,
	save,
}: {
	value?: Connection;
	busy: boolean;
	save: (v: z.input<typeof connectionInput>) => Promise<void>;
}) {
	const [title, setTitle] = useState(value?.title ?? "dots"),
		[enabled, setEnabled] = useState(value?.enabled ?? true),
		[oauth, setOAuth] = useState(!!value?.oauth);
	const [issuer, setIssuer] = useState(value?.oauth?.issuer ?? ""),
		[jwksUrl, setJwks] = useState(value?.oauth?.jwksUrl ?? ""),
		[resource, setResource] = useState(value?.oauth?.resource ?? ""),
		[subject, setSubject] = useState(value?.oauth?.subject ?? "");
	const [id] = useState(value?.id ?? crypto.randomUUID());
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void save({
					id,
					expectedRevision: value?.revision ?? 0,
					title,
					enabled,
					oauth: oauth ? { issuer, jwksUrl, resource, subject } : null,
				});
			}}
		>
			<label>
				名前
				<input
					required
					maxLength={120}
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</label>
			<label>
				<input
					type="checkbox"
					checked={enabled}
					onChange={(e) => setEnabled(e.target.checked)}
				/>
				利用する
			</label>
			<label>
				<input
					type="checkbox"
					disabled={!!value?.oauth}
					checked={oauth}
					onChange={(e) => setOAuth(e.target.checked)}
				/>
				外部接続用のOAuthを設定する
			</label>
			{oauth ? (
				<details open>
					<summary>認証サービスの設定</summary>
					<p>
						認証サービスで発行するアクセストークンの発行元・公開鍵・対象・ユーザーを登録します。保存後に発行元・対象・ユーザーを変更する場合は新しい接続を作ります。
					</p>
					{[
						["発行元", issuer, setIssuer],
						["公開鍵のURL", jwksUrl, setJwks],
						["公開MCPのURL", resource, setResource],
						["ユーザー識別子", subject, setSubject],
					].map(([label, text, set]) => (
						<label key={label as string}>
							{label as string}
							<input
								required
								readOnly={!!value?.oauth && set !== setJwks}
								value={text as string}
								onChange={(e) => (set as (v: string) => void)(e.target.value)}
							/>
						</label>
					))}
				</details>
			) : (
				<p>
					ローカル接続専用です。外部の dots から利用する場合は OAuth
					と公開接続先の設定が必要です。
				</p>
			)}
			<button disabled={busy} type="submit">
				接続を保存
			</button>
		</form>
	);
}
export function ProjectEditor({
	value,
	connections,
	packages,
	busy,
	save,
}: {
	value?: Project;
	connections: Connection[];
	packages: Pack[];
	busy: boolean;
	save: (v: z.input<typeof projectInput>) => Promise<void>;
}) {
	const [ref] = useState(value?.ref ?? crypto.randomUUID()),
		[title, setTitle] = useState(value?.title ?? "");
	const [connectionRef, setConnection] = useState(
			value?.connectionRef ?? connections[0]?.id ?? "",
		),
		[nativeProjectId, setProject] = useState(value?.nativeProjectId ?? ""),
		[hostId, setHost] = useState(value?.hostId ?? "local"),
		[environment, setEnvironment] = useState(value?.environment ?? "local"),
		[enabled, setEnabled] = useState(value?.enabled ?? true),
		[capability, setCapability] = useState(
			value?.capabilityRevisionId ?? "package:dots.orchestrate@1",
		);
	const [ops, setOps] = useState<Project["allowedOperations"]>(
		value?.allowedOperations ?? ["read", "create_session", "edit", "check"],
	);

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void save({
					ref,
					connectionRef,
					expectedRevision: value?.revision ?? 0,
					title,
					nativeProjectId,
					hostId,
					environment,
					enabled,
					capabilityRevisionId: capability,
					allowedOperations: ops,
				});
			}}
		>
			<label>
				名前
				<input
					required
					maxLength={120}
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</label>
			<label>
				接続
				<select
					required
					disabled={!!value}
					value={connectionRef}
					onChange={(e) => setConnection(e.target.value)}
				>
					<option value="">選択</option>
					{connections.map((c) => (
						<option key={c.id} value={c.id}>
							{c.title}
						</option>
					))}
				</select>
			</label>
			<label>
				担当
				<select
					value={capability}
					onChange={(e) => setCapability(e.target.value)}
				>
					<option value="package:dots.orchestrate@1">標準の調整担当</option>
					{packages
						.filter((p) => p.enabled)
						.map((p) => (
							<option key={p.id} value={p.revisionId}>
								{p.title}（版 {p.revision}）
							</option>
						))}
				</select>
			</label>
			<details open>
				<summary>Codexでの対象</summary>
				<label>
					プロジェクトID
					<input
						required
						value={nativeProjectId}
						onChange={(e) => setProject(e.target.value)}
					/>
				</label>
				<label>
					ホストID
					<input
						required
						value={hostId}
						onChange={(e) => setHost(e.target.value)}
					/>
				</label>
				<label>
					実行場所
					<select
						value={environment}
						onChange={(e) =>
							setEnvironment(e.target.value as "local" | "cloud")
						}
					>
						<option value="local">ローカル</option>
						<option value="cloud">クラウド</option>
					</select>
				</label>
			</details>
			<fieldset>
				<legend>このプロジェクトで許可する操作</legend>
				{Object.entries(operationLabels).map(([op, label]) => (
					<label key={op}>
						<input
							type="checkbox"
							checked={ops.includes(op as (typeof ops)[number])}
							onChange={(e) =>
								setOps(
									e.target.checked
										? [...ops, op as (typeof ops)[number]]
										: ops.filter((x) => x !== op),
								)
							}
						/>
						{label}
					</label>
				))}
			</fieldset>
			<label>
				<input
					type="checkbox"
					checked={enabled}
					onChange={(e) => setEnabled(e.target.checked)}
				/>
				利用する
			</label>
			<p>
				進行中の作業がある設定を変更すると、停止確認を待って一時停止します。
			</p>
			<button
				type="submit"
				disabled={busy || !ops.length || !connections.length}
			>
				プロジェクトを保存
			</button>
		</form>
	);
}
