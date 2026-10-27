import { z } from "zod";
import {
	profileDto,
	type RequirementProfileData,
} from "../api/domains/capabilities/contracts";
import { callJson, json, withQuery, type Transport } from "./transport";
export function requirementsClient(t: Transport) {
	const path = (id: string) =>
		`/api/capabilities/requirements/${encodeURIComponent(id)}`;
	return {
		requirementProfiles: async (
			query: { cursor?: string; limit?: number } = {},
		) =>
			callJson(
				t,
				z.object({
					items: z.array(profileDto),
					nextCursor: z.string().nullable(),
				}),
				withQuery("/api/capabilities/requirements", query),
			),
		requirementProfile: async (id: string) => callJson(t, profileDto, path(id)),
		putRequirementProfile: async (
			id: string,
			input: {
				expectedStateToken: string | null;
				data: RequirementProfileData;
			},
		) => callJson(t, profileDto, path(id), json(input, "PUT")),
		setRequirementProfileState: async (
			id: string,
			input: { expectedStateToken: string; enabled: boolean },
		) => callJson(t, profileDto, path(id) + "/state", json(input)),
	};
}
