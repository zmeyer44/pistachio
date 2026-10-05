export * from "@pistachio/agent-runtime/artifacts";

import { ARTIFACT_HOST, type Artifact } from "@pistachio/agent-runtime/artifacts";

/**
 * Where this device serves an artifact's own copy: `pistachio://artifact/<id>`,
 * which opens without an account or a network, where `artifactUrl` is the
 * web app's address for it.
 */
export function artifactPageUrl(id: string): string {
  return `pistachio://${ARTIFACT_HOST}/${id}`;
}

/** One artifact as the shell lists it (`ShellApi.getArtifacts`): the record without its page, and the address that opens it. */
export interface ArtifactListing extends Artifact {
  url: string;
}
