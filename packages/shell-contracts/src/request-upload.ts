export interface BrowserUploadData {
  file?: string;
  blobUUID?: string;
}

/**
 * Electron uses `blobUUID` for any Blob-backed request body, including ordinary
 * API calls made by Service Workers. Only `file` identifies a filesystem file.
 */
export function hasFileUpload(
  uploadData: readonly BrowserUploadData[] | undefined,
): boolean {
  return (
    uploadData?.some(
      (part) => typeof part.file === "string" && part.file.length > 0,
    ) ?? false
  );
}
