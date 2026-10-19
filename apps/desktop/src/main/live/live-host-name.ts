import { execFile } from "node:child_process";
import { hostNameFrom } from "@pistachio/live-share";

/**
 * Who is sharing, as guests are told ("Zach is sharing *Launch plan*",
 * docs/live-share.md §1): read off the Mac's own name as the person set it
 * in System Settings ("Zach's MacBook Pro"). Node's `hostname()` — which the
 * account's device name is made from — is the network name macOS derives
 * from it ("Zachs-MacBook-Pro"), with the apostrophe that says whose Mac it
 * is gone, so the name is asked of macOS itself. Null where it cannot be
 * read or names nobody.
 */
export function macHostName(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1_000 }, (error, stdout) => {
      resolve(error === null ? hostNameFrom(stdout.trim()) : null);
    });
  });
}
