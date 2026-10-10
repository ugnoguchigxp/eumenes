import { z } from "zod";
import {
	profileDto,
	type RequirementProfileData,
} from "../api/domains/capabilities/contracts";
import { json, type Transport } from "./transport";
export function requirementsClient(t: Transport) {
	const path = (id: string) =>
		`/api/capabilities/requirements/${encodeURIComponent(id)}`;
	return {
		requirementProfiles: async (
			query: { cursor?: string; limit?: number } = {},
		) =>
			z
				.object({
					items: z.array(profileDto),
					nextCursor: z.string().nullable(),
				})
				.parse(
					await (
						await t.call(
							`/api/capabilities/requirements?${new URLSearchParams(
								Object.entries(query)
									.filter(([, v]) => v !== undefined)
									.map(([k, v]) => [k, String(v)]),
							)}`,
						)
					).json(),
				),
		requirementProfile: async (id: string) =>
			profileDto.parse(await (await t.call(path(id))).json()),
		putRequirementProfile: async (
			id: string,
			input: {
				expectedStateToken: string | null;
				data: RequirementProfileData;
			},
		) =>
			profileDto.parse(
				await (
					await t.call(path(id), { ...json(input), method: "PUT" })
				).json(),
			),
		setRequirementProfileState: async (
			id: string,
			input: { expectedStateToken: string; enabled: boolean },
		) =>
			profileDto.parse(
				await (await t.call(path(id) + "/state", json(input))).json(),
			),
	};
}
