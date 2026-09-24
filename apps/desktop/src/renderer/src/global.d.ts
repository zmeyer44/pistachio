import type { PistachioApi } from "@pistachio/shell-contracts/ipc";

declare global {
  interface Window {
    pistachio: PistachioApi;
  }
}

export {};
