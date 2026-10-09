import type { UseQueryResult } from "@tanstack/react-query";
import type { Usage } from "../../../../../client/settings";
import {
	type Settings,
	type Purpose,
} from "../../../../../api/domains/settings/contracts";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../design-system";
import { Field, Toggle, purposes, type Change } from "../shared";

type AiSectionProps = {
	value: Settings;
	change: Change;
	usage: UseQueryResult<Usage[]>;
};
export function AiSection({ value, change, usage }: AiSectionProps) {
	return (
		<>
			<div className="settings-notice">
				クラウドへの自動切替は初期値で有効です。代替先を登録すると、会話・録音・読み上げ用のテキストが設定したAPIへ送信されます。
			</div>
			{(Object.keys(purposes) as Purpose[]).map((p) => (
				<Card key={p}>
					<CardHeader>
						<CardTitle>{purposes[p]}</CardTitle>
					</CardHeader>
					<CardContent>
						<Field label="使い方">
							<select
								value={value.routes[p].mode}
								onChange={(e) =>
									change((s) => {
										s.routes[p].mode = e.target
											.value as Settings["routes"][Purpose]["mode"];
									})
								}
							>
								<option value="larm-preferred">
									LARMを優先・クラウドへ自動切替
								</option>
								<option value="larm-only">LARMのみ</option>
								<option value="cloud-only">クラウドのみ</option>
							</select>
						</Field>
						<Field label="クラウド代替先">
							<select
								value={value.routes[p].fallbackId ?? ""}
								onChange={(e) =>
									change((s) => {
										s.routes[p].fallbackId = e.target.value || null;
									})
								}
							>
								<option value="">未登録</option>
								{value.resources
									.filter((r) => r.purpose === p)
									.map((r) => (
										<option key={r.id} value={r.id}>
											{
												value.connections.find((c) => c.id === r.connectionId)
													?.name
											}{" "}
											/ {r.model}
										</option>
									))}
							</select>
						</Field>
						<Toggle
							label="この用途でクラウド送信を許可"
							value={value.routes[p].cloudAllowed}
							onChange={(v) =>
								change((s) => {
									s.routes[p].cloudAllowed = v;
									if (!v && s.routes[p].mode === "cloud-only")
										s.routes[p].mode = "larm-only";
								})
							}
							hint="許可を取り消して適用すると、実行中のクラウド処理も取り消します。"
						/>
						{!value.routes[p].fallbackId && (
							<p className="hint">
								代替先が未登録のため、現在はLARMを使います。
							</p>
						)}
						<p className="hint">
							直近の利用:{" "}
							{(() => {
								const last = usage.data?.find(
									(u) => u.purpose === p && u.accepted,
								);
								return last
									? `${last.source === "larm" ? "LARM" : "クラウド"} / ${last.model}`
									: "まだありません";
							})()}
						</p>
					</CardContent>
				</Card>
			))}
		</>
	);
}
