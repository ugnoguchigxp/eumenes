import { z } from "zod";
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
export const sdkSnapshotSchema = z
	.object({
		workspaceId: id,
		baseSha: sha,
		head: sha,
		files: z
			.array(
				z
					.object({
						path: z.string().min(1).max(1024),
						mode: z.number().int(),
						digest: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.nullable(),
					})
					.strict(),
			)
			.max(10000),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict()
	.refine(
		(v) => Buffer.byteLength(JSON.stringify(v)) <= 384 * 1024,
		"sdk_snapshot_limit",
	);
export const sdkGitRemoteSchema = z
	.object({
		workspaceId: id,
		name: z.string().min(1).max(120),
		url: z.string().min(1).max(2048),
		branch: z.string().min(1).max(200),
		authorName: z.string().min(1).max(200),
		authorEmail: z.string().min(1).max(200),
	})
	.strict();
export const sdkGitSpecSchema = z
	.object({
		grantId: id,
		mode: z.enum(["commit", "commit_push", "push"]),
		remoteId: id,
		files: z.array(z.string().min(1).max(1024)).max(200),
		expiresAt: z.iso.datetime(),
	})
	.strict();
export const sdkGitResultSchema = z
	.object({
		groupId: id,
		remoteId: id,
		commitSha: sha.optional(),
		remoteSha: sha.optional(),
		commitVerified: z.boolean(),
		pushVerified: z.boolean(),
		unknown: z.boolean(),
		reason: z
			.string()
			.regex(/^[a-z_]+$/)
			.optional(),
	})
	.strict();
export type SdkGitResult = z.infer<typeof sdkGitResultSchema>;
export type SdkGitRemote = z.infer<typeof sdkGitRemoteSchema>;
export type SdkSnapshot = z.infer<typeof sdkSnapshotSchema>;
export const sdkGitPhaseSchema = z
	.object({
		groupId: id,
		grantId: id,
		remoteId: id,
		workspaceId: id,
		cwd: z.string(),
		directory: z.string(),
		phase: z.enum(["commit", "push"]),
		expiresAt: z.iso.datetime(),
		snapshot: sdkSnapshotSchema,
		files: z.array(z.string()),
		remote: sdkGitRemoteSchema,
		integrity: z.string().regex(/^[a-f0-9]{64}$/),
		expectedRemoteSha: sha.nullable(),
		commitSha: sha.optional(),
	})
	.strict();
export type SdkGitPhase = z.infer<typeof sdkGitPhaseSchema>;
