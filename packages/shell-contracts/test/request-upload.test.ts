import { describe, expect, it } from "vitest";
import { hasFileUpload } from "../src/request-upload.js";

describe("browser request upload classification", () => {
  it("does not mistake a Blob-backed API body for a file upload", () => {
    expect(hasFileUpload([{ blobUUID: "service-worker-request-body" }])).toBe(
      false,
    );
  });

  it("recognizes filesystem-backed upload data", () => {
    expect(hasFileUpload([{ file: "/tmp/report.pdf" }])).toBe(true);
    expect(
      hasFileUpload([
        { blobUUID: "multipart-fields" },
        { file: "/tmp/report.pdf" },
      ]),
    ).toBe(true);
  });

  it("ignores absent and empty upload data", () => {
    expect(hasFileUpload(undefined)).toBe(false);
    expect(hasFileUpload([])).toBe(false);
    expect(hasFileUpload([{ file: "" }])).toBe(false);
  });
});
