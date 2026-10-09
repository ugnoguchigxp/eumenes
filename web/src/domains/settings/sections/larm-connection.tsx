import type { UseQueryResult } from "@tanstack/react-query";
import type { LarmDetails } from "../../../../../client/settings";
import type {
	Purpose,
	Settings,
} from "../../../../../api/domains/settings/contracts";
import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Input,
} from "../../../design-system";
import { Field, KnownVoiceSelect, purposes, type Change } from "../shared";

type LarmConnectionCardProps = {
	value: Settings;
	change: Change;
	dirty: boolean;
	details: UseQueryResult<LarmDetails>;
	probe: (target: string) => Promise<void>;
};
export function LarmConnectionCard({
	value,
	change,
	dirty,
	details,
	probe,
}: LarmConnectionCardProps) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>LARM</CardTitle>
			</CardHeader>
			<CardContent>
				<Field label="LARMのURL" hint="空欄ならbackend既定のLARMに接続します。">
					<Input
						value={value.larm.baseUrl ?? ""}
						placeholder="http://127.0.0.1:…"
						onChange={(e) =>
							change((s) => {
								s.larm.baseUrl = e.target.value || null;
							})
						}
					/>
				</Field>
				<Field label="Profile">
					<Input
						value={value.larm.profile}
						onChange={(e) =>
							change((s) => {
								s.larm.profile = e.target.value;
							})
						}
					/>
				</Field>
				<Field label="接続方式">
					<select
						value={value.larm.audience}
						onChange={(e) =>
							change((s) => {
								s.larm.audience = e.target
									.value as Settings["larm"]["audience"];
							})
						}
					>
						<option value="saaa-desktop">LARMが提供する接続</option>
						<option value="same-host">同じ端末の接続</option>
					</select>
				</Field>
				<Field
					label="読み上げ音声の上書き"
					hint="空欄ならLARMが指定する音声を使います。"
				>
					<KnownVoiceSelect
						value={value.larm.voice}
						emptyLabel="LARMの指定に従う"
						onChange={(id) =>
							change((s) => {
								s.larm.voice = id;
							})
						}
					/>
				</Field>
				<p className="hint">
					LARMの認証情報はbackendの環境変数を使います。音声にはProfile全体の提供が必要です。
				</p>
				<Button
					variant="secondary"
					disabled={dirty}
					onClick={() => void probe("larm")}
				>
					LARMの接続を確認
				</Button>
				{details.data?.providers.map((p) => (
					<p key={p.name}>
						{purposes[p.name as Purpose]}: {p.model}
						<small className="hint"> {p.baseUrl}</small>
					</p>
				))}
			</CardContent>
		</Card>
	);
}
