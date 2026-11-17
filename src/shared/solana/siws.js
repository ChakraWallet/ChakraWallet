// Sign In With Solana (the Wallet Standard's solana:signIn): the text the user signs, built from the site's request.
// The page's domain is always the real one (the background puts it there).

/** The text to sign: the same lines, in the same order, as the standard's reference implementation. */
export function signInText(input) {
  let m = `${input.domain} wants you to sign in with your Solana account:\n${input.address}`;
  if (input.statement) m += `\n\n${input.statement}`;
  const f = [];
  if (input.uri) f.push(`URI: ${input.uri}`);
  if (input.version) f.push(`Version: ${input.version}`);
  if (input.chainId) f.push(`Chain ID: ${input.chainId}`);
  if (input.nonce) f.push(`Nonce: ${input.nonce}`);
  if (input.issuedAt) f.push(`Issued At: ${input.issuedAt}`);
  if (input.expirationTime) f.push(`Expiration Time: ${input.expirationTime}`);
  if (input.notBefore) f.push(`Not Before: ${input.notBefore}`);
  if (input.requestId) f.push(`Request ID: ${input.requestId}`);
  if (Array.isArray(input.resources) && input.resources.length) f.push('Resources:', ...input.resources.map((r) => `- ${r}`));
  return f.length ? `${m}\n\n${f.join('\n')}` : m;
}

