import { describe, expect, it } from "vitest";
import { base64urlDecode, base64urlEncode, toBase64, utf8 } from "../src/index.js";

describe("base64url", () => {
  it("encodes without padding and with the url alphabet", () => {
    // 0xfb 0xff round-trips through '+' and '/' in standard base64.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    expect(toBase64(bytes)).toBe("+/+/");
    expect(base64urlEncode(bytes)).toBe("-_-_");
    expect(base64urlEncode(utf8("a"))).toBe("YQ");
    expect(base64urlEncode(utf8("ab"))).toBe("YWI");
    expect(base64urlEncode(new Uint8Array())).toBe("");
  });

  it("round-trips every input length modulo 4", () => {
    for (let length = 0; length < 12; length++) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + length) % 256);
      expect([...base64urlDecode(base64urlEncode(bytes))]).toEqual([...bytes]);
    }
  });

  it("decodes padded and unpadded input alike", () => {
    expect([...base64urlDecode("YQ")]).toEqual([0x61]);
    expect([...base64urlDecode("YQ==")]).toEqual([0x61]);
    expect([...base64urlDecode("-_-_")]).toEqual([0xfb, 0xff, 0xbf]);
  });
});
