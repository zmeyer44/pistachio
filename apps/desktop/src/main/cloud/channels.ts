/**
 * Channels — the authenticated webhooks bound to one Space that start cloud
 * runs (docs/cloud-sync-design.md §7.3). Thin over control: the desktop only
 * lists, creates, and revokes links. The one-time secret rides only on the
 * create answer and is never stored here.
 */

import type { ChannelCreateRequest, ChannelCreated, ChannelInfo } from "@pistachio/shell-contracts/ipc";
import type { ControlClient } from "../account/control-client";
import type { ChannelsFeature } from "../feature-handlers";

export interface ChannelsDeps {
  /** The control client while enrolled; null otherwise. */
  control(): ControlClient | null;
}

export function createChannelsFeature(deps: ChannelsDeps): ChannelsFeature {
  const require = (what: string): ControlClient => {
    const control = deps.control();
    if (control === null) throw new Error(`Sign in and enroll this Mac to ${what}.`);
    return control;
  };
  return {
    list: async (): Promise<ChannelInfo[]> => {
      const control = deps.control();
      return control === null ? [] : control.listChannels();
    },
    create: async (request: ChannelCreateRequest): Promise<ChannelCreated> => {
      const control = require("create a channel");
      const created = await control.createChannel(request);
      const listed = (await control.listChannels().catch(() => [])).find(
        (channel) => channel.linkId === created.linkId,
      );
      return {
        linkId: created.linkId,
        name: listed?.name ?? request.name,
        spaceId: listed?.spaceId ?? request.spaceId,
        outboundUrl: listed?.outboundUrl ?? request.outboundUrl ?? null,
        createdAt: listed?.createdAt ?? new Date().toISOString(),
        revokedAt: null,
        secret: created.secret,
      };
    },
    delete: async (linkId: string): Promise<ChannelInfo[]> => {
      const control = require("manage channels");
      await control.deleteChannel(linkId);
      return control.listChannels();
    },
  };
}
