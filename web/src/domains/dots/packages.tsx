import { useState } from "react";
import type { EumenesClient } from "../../../../client";
type Pack = Awaited<ReturnType<EumenesClient["dotsPackages"]>>["items"][number];
export function PackageEditor({
	client,
	items,
	save,
	busy,
}: {
	client: EumenesClient;
	items: Pack[];
	save: (f: () => Promise<unknown>) => Promise<void>;
	busy: boolean;
}) {
	const [selected, setSelected] = useState("");
	const value = items.find((p) => p.id === selected);
	return (
		<section>
			<h3>担当とSkill</h3>
			<p>
				役割の指示と、作業で使う手順を登録します。保存ごとに新しい版を作り、プロジェクトで使う版を選びます。
			</p>
			<select
				aria-label="編集する担当"
				value={selected}
				onChange={(e) => setSelected(e.target.value)}
			>
				<option value="">新しい担当</option>
				{items.map((p) => (
					<option key={p.id} value={p.id}>
						{p.title}（版 {p.revision}）
					</option>
				))}
			</select>
			<Editor
				key={`${selected}:${value?.stateToken}`}
				value={value}
				busy={busy}
				save={(v) =>
					save(async () => {
						const r = await client.configureDotsPackage(v);
						setSelected(r.id);
					})
				}
			/>
		</section>
	);
}
function Editor({
	value,
	busy,
	save,
}: {
	value?: Pack;
	busy: boolean;
	save: (
		v: Parameters<EumenesClient["configureDotsPackage"]>[0],
	) => Promise<void>;
}) {
	const [id] = useState(
			value?.id ?? `dots.user.${crypto.randomUUID().replaceAll("-", "")}`,
		),
		[title, setTitle] = useState(value?.title ?? ""),
		[summary, setSummary] = useState(value?.summary ?? ""),
		[profile, setProfile] = useState(value?.profile ?? ""),
		[enabled, setEnabled] = useState(value?.enabled ?? true),
		[skills, setSkills] = useState(
			value?.skills ?? [{ title: "作業手順", body: "" }],
		);
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void save({
					id,
					expectedToken: value?.stateToken ?? null,
					title,
					summary,
					profile,
					skills,
					enabled,
				});
			}}
		>
			<label>
				担当名
				<input
					required
					maxLength={120}
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</label>
			<label>
				どの作業に使うか
				<input
					required
					maxLength={600}
					value={summary}
					onChange={(e) => setSummary(e.target.value)}
				/>
			</label>
			<label>
				役割の指示
				<textarea
					required
					maxLength={8000}
					value={profile}
					onChange={(e) => setProfile(e.target.value)}
				/>
			</label>
			{skills.map((s, i) => (
				<fieldset key={i}>
					<legend>Skill {i + 1}</legend>
					<label>
						名前
						<input
							required
							maxLength={120}
							value={s.title}
							onChange={(e) =>
								setSkills(
									skills.map((s, n) =>
										n === i ? { ...s, title: e.target.value } : s,
									),
								)
							}
						/>
					</label>
					<label>
						手順
						<textarea
							required
							maxLength={8000}
							value={s.body}
							onChange={(e) =>
								setSkills(
									skills.map((s, n) =>
										n === i ? { ...s, body: e.target.value } : s,
									),
								)
							}
						/>
					</label>
					<button
						type="button"
						disabled={skills.length === 1}
						onClick={() => setSkills(skills.filter((_, n) => n !== i))}
					>
						このSkillを削除
					</button>
				</fieldset>
			))}
			<button
				type="button"
				disabled={skills.length >= 4}
				onClick={() => setSkills([...skills, { title: "", body: "" }])}
			>
				Skillを追加
			</button>
			<label>
				<input
					type="checkbox"
					checked={enabled}
					onChange={(e) => setEnabled(e.target.checked)}
				/>
				利用する
			</label>
			<button disabled={busy} type="submit">
				担当を保存
			</button>
		</form>
	);
}
