const b64urlEncode = (bytes: Uint8Array | string): string => {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...data)).replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_");
};

const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/") + pad), (c) => c.charCodeAt(0));
};

export interface SessionClaims {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSessionJwt(claims: SessionClaims, secret: string): Promise<string> {
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const key = await signingKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

export async function verifySessionJwt(token: string, secret: string): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const key = await signingKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlDecode(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as SessionClaims;
    if (claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}
