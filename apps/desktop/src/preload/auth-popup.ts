import { contextBridge, ipcRenderer } from "electron";

// Loaded only by the app-owned popup strip, never by the sign-in website.
contextBridge.exposeInMainWorld("pistachioPopup", {
  selectPasskey: (requestId: string, accountId: string | null): void => {
    ipcRenderer.send("pistachio:popup-select-passkey", requestId, accountId);
  },
});
