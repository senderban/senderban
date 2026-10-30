import { describe, expect, it } from "vitest";
import { AdapterError } from "../src/adapter.js";
import { isCertificateRefusal } from "../src/tls-refusal.js";

const coded = (code: string) => Object.assign(new Error("tls"), { code });

describe("isCertificateRefusal", () => {
  it.each([
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ])("knows %s, also behind an adapter error", (code) => {
    expect(isCertificateRefusal(coded(code))).toBe(true);
    const wrapped = new AdapterError("TRANSIENT", "TLS error", { cause: coded(code) });
    expect(isCertificateRefusal(wrapped)).toBe(true);
  });

  it.each(["ECONNREFUSED", "ETIMEDOUT", "ERR_SSL_PACKET_LENGTH_TOO_LONG"])(
    "does not call %s a certificate problem",
    (code) => {
      expect(isCertificateRefusal(coded(code))).toBe(false);
    },
  );

  it("never reads the text of an error", () => {
    expect(isCertificateRefusal(new Error("CERT_HAS_EXPIRED"))).toBe(false);
  });

  it("answers no for what is not an error, and stops on a cause that points at itself", () => {
    expect(isCertificateRefusal(null)).toBe(false);
    expect(isCertificateRefusal("CERT_HAS_EXPIRED")).toBe(false);
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(isCertificateRefusal(loop)).toBe(false);
  });
});
