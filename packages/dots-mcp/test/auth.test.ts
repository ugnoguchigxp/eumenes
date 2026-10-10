import { expect, test } from "bun:test";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { verifyAccess } from "../src";
test("real JWT signatures enforce issuer, subject, audience, time and every required scope", async () => {
	const { privateKey, publicKey } = await generateKeyPair("ES256"),
		jwk = await exportJWK(publicKey);
	jwk.kid = "fixture";
	const keys = createLocalJWKSet({ keys: [jwk] });
	const config = {
		issuer: "https://issuer.example",
		resource: "https://mcp.example/mcp/dots/dots",
		jwksUrl: "https://issuer.example/keys",
		subject: "owner",
	};
	const token = async (
		scope = "dots:read dots:report dots:events",
		subject = "owner",
		audience = config.resource,
		expiration = "1h",
	) =>
		new SignJWT({ scope })
			.setProtectedHeader({ alg: "ES256", kid: "fixture" })
			.setIssuedAt()
			.setIssuer(config.issuer)
			.setSubject(subject)
			.setAudience(audience)
			.setExpirationTime(expiration)
			.sign(privateKey);
	expect(await verifyAccess(config, await token(), keys)).toMatchObject({
		subject: "owner",
	});
	const issuedAt = Math.floor(Date.now() / 1000) - 3500;
	const longLived = await new SignJWT({
		scope: "dots:read dots:report dots:events",
	})
		.setProtectedHeader({ alg: "ES256", kid: "fixture" })
		.setIssuedAt(issuedAt)
		.setIssuer(config.issuer)
		.setSubject(config.subject)
		.setAudience(config.resource)
		.setExpirationTime("24h")
		.sign(privateKey);
	expect((await verifyAccess(config, longLived, keys)).expiresAt).toBe(
		(issuedAt + 3600) * 1000,
	);
	await expect(
		verifyAccess(config, await token("dots:read"), keys),
	).rejects.toThrow();
	await expect(
		verifyAccess(config, await token(undefined, "stranger"), keys),
	).rejects.toThrow();
	await expect(
		verifyAccess(config, await token(undefined, undefined, "wrong"), keys),
	).rejects.toThrow();
	await expect(
		verifyAccess(
			config,
			await token(undefined, undefined, undefined, "-1s"),
			keys,
		),
	).rejects.toThrow();
});
