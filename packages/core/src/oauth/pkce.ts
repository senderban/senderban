import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Random bytes behind the PKCE verifier and the `state`. 32 bytes = 256 bits; the verifier is 43 base64url
 * characters (RFC 7636 §4.1: 43-128), the state is 43 as well (RFC 6749 §10.12 asks for an unguessable value).
 */
export const RANDOM_BYTES = 32;

/** The PKCE verifier: 43-128 characters of the unreserved set (RFC 7636 §4.1). */
export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;

export interface Pkce {
  readonly verifier: string;
  /** S256: base64url(SHA-256(verifier)), no padding. */
  readonly challenge: string;
}

export function newPkce(): Pkce {
  const verifier = randomBytes(RANDOM_BYTES).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function newState(): string {
  return randomBytes(RANDOM_BYTES).toString("base64url");
}

/** Constant-time comparison of the `state` that came back; any other length is a different value. */
export function stateMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The redirect URI of a loopback listener, in the form the provider documents. */
export function loopbackRedirectUri(
  port: number,
  hostName: LoopbackHostName = "127.0.0.1",
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("port must be an integer from 1 to 65535");
  }
  return `http://${hostName}:${String(port)}`;
}

/** Google documents the address, Microsoft the name (its portal does not take an http address). Both reach 127.0.0.1. */
export type LoopbackHostName = "127.0.0.1" | "localhost";
