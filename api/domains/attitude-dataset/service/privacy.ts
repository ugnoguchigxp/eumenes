/** Reject rather than persist a partial credential. This is a guard, not a general PII anonymizer. */
export function containsCredential(text: string) {
	return /\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:sk-|hf_|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|token|password|credential|パスワード|秘密鍵)\s*[:=]\s*["']?[^\s"']{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(
		text,
	);
}
