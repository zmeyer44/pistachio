/**
 * Gmail's wire shapes in and out: a `Message` resource read into what the
 * agent sees, and an outgoing message assembled the way `messages.send`
 * takes it.
 */

import { describe, expect, it } from "vitest";
import {
  buildRawMessage,
  encodeHeaderText,
  formatMailbox,
  htmlToText,
  messageView,
  parseMailbox,
  parseMailboxes,
  replyContext,
  replySubject,
  type GmailMessageResource,
} from "../src/integrations/index.js";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

function resource(overrides: Partial<GmailMessageResource> = {}): GmailMessageResource {
  return {
    id: "18f0a1",
    threadId: "18f0a0",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Hi Alex &mdash; the invoice is attached",
    internalDate: String(Date.parse("2026-09-05T14:30:00Z")),
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Sam Rivera <sam@vendor.example>" },
        { name: "To", value: "alex@example.com" },
        { name: "Cc", value: "ops@example.com" },
        { name: "Subject", value: "Invoice NS-2048" },
        { name: "Message-ID", value: "<abc@vendor.example>" },
        { name: "References", value: "<root@vendor.example>" },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64("Hi Alex,\r\n\r\nThe invoice is attached.\r\n\r\nSam") } },
            { mimeType: "text/html", body: { data: b64("<p>Hi Alex,</p><p>The invoice is <b>attached</b>.</p>") } },
          ],
        },
        { mimeType: "application/pdf", filename: "NS-2048.pdf", body: { size: 48_213, attachmentId: "att-1" } },
      ],
    },
    ...overrides,
  };
}

describe("reading a message", () => {
  it("prefers the plain part, lists attachments, and reads the headers and labels", () => {
    const view = messageView(resource());
    expect(view).toMatchObject({
      id: "18f0a1",
      threadId: "18f0a0",
      date: "2026-09-05T14:30:00.000Z",
      from: "Sam Rivera <sam@vendor.example>",
      to: "alex@example.com",
      cc: "ops@example.com",
      subject: "Invoice NS-2048",
      snippet: "Hi Alex — the invoice is attached",
      unread: true,
      body: "Hi Alex,\n\nThe invoice is attached.\n\nSam",
      truncated: false,
      attachments: [{ filename: "NS-2048.pdf", mimeType: "application/pdf", size: 48_213 }],
      webUrl: "https://mail.google.com/mail/u/0/#all/18f0a1",
    });
  });

  it("renders HTML-only mail as text and caps a long body", () => {
    const html = resource({
      payload: {
        mimeType: "text/html",
        headers: [{ name: "Subject", value: "Newsletter" }],
        body: { data: b64('<html><head><style>p{}</style></head><body><h1>News</h1><p>Read <a href="https://x.example/a">the post</a> today.</p><ul><li>one</li><li>two</li></ul>&copy; 2026</body></html>') },
      },
    });
    expect(messageView(html).body).toBe("News\nRead the post [https://x.example/a] today.\n• one\n• two\n© 2026");
    const long = resource({ payload: { mimeType: "text/plain", headers: [], body: { data: b64("x".repeat(100)) } } });
    const view = messageView(long, { maxBodyChars: 40 });
    expect(view.truncated).toBe(true);
    expect(view.body.startsWith("x".repeat(40))).toBe(true);
    expect(view.body.endsWith("…[truncated]")).toBe(true);
  });

  it("copes with a metadata-only resource", () => {
    const view = messageView({ id: "1", threadId: "2", payload: { headers: [{ name: "Subject", value: "Only headers" }] } });
    expect(view.body).toBe("");
    expect(view.date).toBeNull();
    expect(view.unread).toBe(false);
    expect(view.attachments).toEqual([]);
  });

  it("strips tags and decodes entities", () => {
    expect(htmlToText("a<br>b<br/>c &amp; d &#39;e&#39; &#x41;")).toBe("a\nb\nc & d 'e' A");
    expect(htmlToText("<div>x</div>\n\n\n<div>y</div>")).toBe("x\n\ny");
  });
});

describe("replying", () => {
  it("threads on the original's ids and answers its Reply-To", () => {
    const context = replyContext(resource());
    expect(context).toMatchObject({ threadId: "18f0a0", messageId: "<abc@vendor.example>", references: "<root@vendor.example>", replyTo: "Sam Rivera <sam@vendor.example>" });
    const withReplyTo = resource();
    withReplyTo.payload!.headers!.push({ name: "Reply-To", value: "billing@vendor.example" });
    expect(replyContext(withReplyTo).replyTo).toBe("billing@vendor.example");
    expect(replySubject("Invoice NS-2048")).toBe("Re: Invoice NS-2048");
    expect(replySubject("RE: Invoice NS-2048")).toBe("RE: Invoice NS-2048");
  });
});

describe("mailboxes", () => {
  it("parses bare addresses, named addresses, and quoted names with commas inside", () => {
    expect(parseMailboxes("a@x.com, Sam <sam@vendor.example>; ,")).toEqual([
      { address: "a@x.com", name: "" },
      { address: "sam@vendor.example", name: "Sam" },
    ]);
    expect(parseMailboxes(['"Doe, Jane" <jane@example.com>', " "])).toEqual([{ address: "jane@example.com", name: "Doe, Jane" }]);
    expect(parseMailboxes('"Doe, Jane" <jane@example.com>, Zoë <zoe@example.com>')).toEqual([
      { address: "jane@example.com", name: "Doe, Jane" },
      { address: "zoe@example.com", name: "Zoë" },
    ]);
    expect(parseMailbox('"Quote \\"me\\"" <q@example.com>')).toEqual({ address: "q@example.com", name: 'Quote "me"' });
    expect(parseMailboxes(null)).toEqual([]);
  });

  it("refuses what is not a mailbox", () => {
    expect(() => parseMailbox("not an address")).toThrow("not an email address");
    expect(() => parseMailbox("a@x")).toThrow("not an email address");
    expect(() => parseMailbox("Sam <sam@vendor.example")).toThrow("malformed");
    expect(() => parseMailbox("Sam <> ")).toThrow("not an email address");
    expect(() => parseMailbox("a@x.com <b@y.com>")).toThrow("name is malformed");
  });

  it("refuses a line break or control character anywhere, so a name can never smuggle a header", () => {
    expect(() => parseMailbox("Mallory\r\nBcc: hidden@example.com <visible@example.com>")).toThrow("line break or control character");
    expect(() => parseMailboxes(["ok@example.com", "bad\n@example.com"])).toThrow("line break or control character");
    expect(() => parseMailbox("Tab\there <t@example.com>")).toThrow("line break or control character");
    expect(() => parseMailbox('"Quoted\r\nBcc: x@y.com" <v@example.com>')).toThrow("line break or control character");
  });

  it("writes a mailbox back quoted or encoded as its name needs", () => {
    expect(formatMailbox({ address: "a@x.com", name: "" })).toBe("a@x.com");
    expect(formatMailbox({ address: "sam@vendor.example", name: "Sam Rivera" })).toBe("Sam Rivera <sam@vendor.example>");
    expect(formatMailbox({ address: "jane@example.com", name: "Doe, Jane" })).toBe('"Doe, Jane" <jane@example.com>');
    expect(formatMailbox({ address: "q@example.com", name: 'Quote "me"' })).toBe('"Quote \\"me\\"" <q@example.com>');
    expect(formatMailbox({ address: "zoe@example.com", name: "Zoë" })).toBe("=?utf-8?B?Wm/Dqw==?= <zoe@example.com>");
    expect(encodeHeaderText("plain")).toBe("plain");
    expect(encodeHeaderText("café")).toBe("=?utf-8?B?Y2Fmw6k=?=");
  });
});

describe("writing a message", () => {
  const decode = (raw: string): string => Buffer.from(raw, "base64url").toString("utf8");
  const box = (address: string, name = ""): { address: string; name: string } => ({ address, name });

  it("assembles RFC 5322 headers, encodes non-ASCII, and base64s the body", () => {
    const raw = buildRawMessage(
      {
        from: box("alex@example.com"),
        to: [box("sam@vendor.example", "Sam Rivera"), box("zoe@example.com", "Zoë"), box("jane@example.com", "Doe, Jane")],
        cc: [],
        bcc: [box("me+archive@example.com")],
        subject: "Re: Invoice — paid ✓",
        body: "Thanks Sam,\n\nPaid today.\n",
      },
      () => new Date("2026-09-06T12:00:00Z"),
    );
    const text = decode(raw);
    const [head, body] = text.split("\r\n\r\n");
    expect(head!.split("\r\n")).toEqual([
      "From: alex@example.com",
      'To: Sam Rivera <sam@vendor.example>, =?utf-8?B?Wm/Dqw==?= <zoe@example.com>, "Doe, Jane" <jane@example.com>',
      "Bcc: me+archive@example.com",
      "Subject: =?utf-8?B?UmU6IEludm9pY2Ug4oCUIHBhaWQg4pyT?=",
      "Date: Sun, 06 Sep 2026 12:00:00 GMT",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(body!.replace(/\r\n/gu, ""), "base64").toString("utf8")).toBe("Thanks Sam,\r\n\r\nPaid today.\r\n");
  });

  it("folds a line break in the subject or a threading id rather than letting it start a header", () => {
    const text = decode(
      buildRawMessage({
        from: box("alex@example.com"),
        to: [box("sam@vendor.example")],
        cc: [],
        bcc: [],
        subject: "Hello\r\nBcc: hidden@example.com",
        body: "b",
        inReplyTo: "<m@x>\r\nBcc: hidden@example.com",
      }),
    );
    const headers = text.split("\r\n\r\n")[0]!.split("\r\n");
    expect(headers.some((line) => line.startsWith("Bcc:"))).toBe(false);
    expect(headers).toContain("Subject: Hello Bcc: hidden@example.com");
    expect(headers).toContain("In-Reply-To: <m@x> Bcc: hidden@example.com");
  });

  it("threads a reply with In-Reply-To and References", () => {
    const text = decode(
      buildRawMessage({
        from: box("alex@example.com"),
        to: [box("sam@vendor.example")],
        cc: [],
        bcc: [],
        subject: "Re: Invoice",
        body: "ok",
        inReplyTo: "<abc@vendor.example>",
        references: "<root@vendor.example>",
      }),
    );
    expect(text).toContain("In-Reply-To: <abc@vendor.example>\r\n");
    expect(text).toContain("References: <root@vendor.example> <abc@vendor.example>\r\n");
    const first = decode(buildRawMessage({ from: box("a@x.com"), to: [box("b@y.com")], cc: [], bcc: [], subject: "s", body: "b", inReplyTo: "<m@x>" }));
    expect(first).toContain("References: <m@x>\r\n");
  });
});
