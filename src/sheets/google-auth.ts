/**
 * Stage 7: Google service-account auth with node:crypto and fetch (no dependency).
 *
 * The OAuth 2.0 "JWT bearer" flow (https://developers.google.com/identity/protocols/oauth2/service-account):
 *   1. Build a JWT { iss: client_email, scope, aud: token URL, iat, exp = iat + 1h }.
 *   2. Sign it with the service account's private key, RS256 (RSA PKCS#1 v1.5 + SHA-256).
 *   3. POST it to https://oauth2.googleapis.com/token and get a short-lived access token.
 * The fetch function is injected so tests run against a fake, with a throwaway key.
 */
import { sign } from "node:crypto";
import type { ServiceAccount } from "./config.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const base64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export interface JwtClaims {
  iss: string;
  scope: string;
  aud: string;
  iat: number;
  exp: number;
}

export function serviceAccountClaims(account: ServiceAccount, now: Date = new Date()): JwtClaims {
  const iat = Math.floor(now.getTime() / 1000);
  return { iss: account.client_email, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
}

/** header.payload.signature, signed RS256 with a PEM private key. */
export function signJwt(claims: object, privateKeyPem: string): string {
  const input = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
  let signature: Buffer;
  try {
    signature = sign("sha256", Buffer.from(input), privateKeyPem);
  } catch (err) {
    throw new Error(`cannot sign with the service account private_key: ${(err as Error).message}`);
  }
  return `${input}.${base64url(signature)}`;
}

/** Exchanges a signed JWT for an access token (valid about an hour; one run needs one). */
export async function fetchAccessToken(account: ServiceAccount, fetchFn: FetchLike = fetch, now: Date = new Date()): Promise<string> {
  const assertion = signJwt(serviceAccountClaims(account, now), account.private_key);
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    // Google answers e.g. {"error":"invalid_grant","error_description":"Invalid JWT Signature."}
    throw new Error(`Google token request failed: ${res.status} ${text.slice(0, 200)}`);
  }
  let body: { access_token?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Google token response is not JSON");
  }
  if (typeof body.access_token !== "string" || body.access_token === "") throw new Error("Google token response has no access_token");
  return body.access_token;
}
