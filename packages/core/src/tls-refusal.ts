/** Node's codes for a certificate that failed verification (X509 errors of `tls.connect`, and its host name check). */
const CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
  "INVALID_CA",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** Errors wrapped around the first one, at most; a cause chain from a library is short. */
const MAX_CAUSES = 4;

/**
 * True when a connection failed because the server's certificate did not verify: a possible interception, which a person must be
 * able to tell from a server that is simply down. Reads only the fixed `code`, never the error's text.
 */
export function isCertificateRefusal(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth <= MAX_CAUSES; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && typeof current.code === "string") {
      if (CERTIFICATE_CODES.has(current.code)) return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
