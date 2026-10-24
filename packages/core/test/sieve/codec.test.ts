import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/adapter.js";
import { capabilitiesOf, parseResponse } from "../../src/sieve/codec.js";

const parse = (text: string) => parseResponse(Buffer.from(text, "utf8"));

describe("parseResponse", () => {
  it("parses a capability greeting", () => {
    const text =
      '"IMPLEMENTATION" "Dovecot Pigeonhole"\r\n"SIEVE" "fileinto include envelope"\r\n"STARTTLS"\r\n"SASL" ""\r\nOK "Dovecot ready."\r\n';
    const parsed = parse(text);
    expect(parsed?.consumed).toBe(text.length);
    expect(parsed?.response.status).toBe("OK");
    expect(parsed?.response.text).toBe("Dovecot ready.");
    const caps = capabilitiesOf(
      parsed?.response ?? { status: "OK", code: null, text: null, data: [] },
    );
    expect(caps.get("SIEVE")).toBe("fileinto include envelope");
    expect(caps.has("STARTTLS")).toBe(true);
    expect(caps.get("SASL")).toBe("");
  });

  it("is case-insensitive about the status word and handles a bare OK", () => {
    expect(parse("Ok\r\n")?.response).toEqual({ status: "OK", code: null, text: null, data: [] });
    expect(parse('no (NONEXISTENT) "There is no script by that name"\r\n')?.response).toMatchObject(
      {
        status: "NO",
        code: "NONEXISTENT",
        text: "There is no script by that name",
      },
    );
  });

  it("reads response codes with parameters and slashes", () => {
    expect(parse('NO (QUOTA/MAXSIZE) "Quota exceeded"\r\n')?.response.code).toBe("QUOTA/MAXSIZE");
    expect(parse('OK (SASL "dGVzdA==")\r\n')?.response.code).toBe('SASL "dGVzdA=="');
    expect(parse('BYE (REFERRAL "sieve://other.example")\r\n')?.response.status).toBe("BYE");
  });

  it("parses LISTSCRIPTS with and without ACTIVE", () => {
    const r = parse('"a"\r\n"b" ACTIVE\r\n"c d"\r\nOK "Listscripts completed."\r\n')?.response;
    expect(r?.data.map((l) => l.map((t) => t.value))).toEqual([["a"], ["b", "ACTIVE"], ["c d"]]);
  });

  it("parses GETSCRIPT returned as a literal, including multi-byte text", () => {
    const body = 'if header :is "subject" "ünï" { stop; }\r\n';
    const len = Buffer.byteLength(body);
    const r = parse(`{${String(len)}}\r\n${body}\r\nOK "Getscript completed."\r\n`)?.response;
    expect(r?.data[0]?.[0]).toEqual({ kind: "string", value: body });
    expect(r?.status).toBe("OK");
  });

  it("parses a NO whose text is a literal", () => {
    const r = parse("NO (NONEXISTENT) {31}\r\nThere is no script by that name\r\n")?.response;
    expect(r?.text).toBe("There is no script by that name");
  });

  it("unescapes quoted strings", () => {
    const r = parse('"a\\"b\\\\c"\r\nOK\r\n')?.response;
    expect(r?.data[0]?.[0]?.value).toBe('a"b\\c');
  });

  it("returns null at every cut point of an incomplete response, and consumes only one response", () => {
    const first = '"x"\r\nOK (QUOTA) {3}\r\nabc\r\n';
    const whole = Buffer.from(`${first}"next"\r\nOK\r\n`);
    for (let cut = 0; cut < first.length; cut += 1) {
      expect(parseResponse(whole.subarray(0, cut))).toBeNull();
    }
    expect(parseResponse(whole)?.consumed).toBe(first.length);
  });

  it("rejects malformed input", () => {
    for (const bad of [
      '"abc\r\n',
      "{x}\r\n",
      "{3+}\r\nabc\r\nOK\r\n",
      'OK "x" trailing\r\n',
      "OK (unterminated\r\n",
      "{99999999999}\r\n",
    ]) {
      expect(() => parse(bad), bad).toThrow(AdapterError);
    }
  });

  it("refuses a literal bigger than the response limit", () => {
    expect(() => parse("{4194305}\r\n")).toThrow(AdapterError);
  });
});
