import { describe, expect, it } from "vitest";
import { isPrivateHost } from "../src/private-network.js";

/**
 * The guard on a page read (main/browser-controller.ts `fetchPageHtml`): the
 * read carries the person's cookies to an address the agent named, so every
 * way of writing "somewhere private" has to be caught, including the ones
 * that exist to slip past a naive check.
 */
describe("addresses that are not on the public web", () => {
  it("catches loopback, however it is spelled", () => {
    for (const host of ["127.0.0.1", "127.1.1.1", "localhost", "app.localhost", "[::1]", "::1", "0.0.0.0"]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("catches the cloud metadata endpoint and the rest of link-local", () => {
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("169.254.0.1")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
  });

  it("catches every private IPv4 range", () => {
    for (const host of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "100.64.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("does not mistake public neighbours of those ranges for private ones", () => {
    for (const host of ["172.15.0.1", "172.32.0.1", "192.169.0.1", "100.63.0.1", "100.128.0.1", "198.20.0.1", "169.253.0.1", "11.0.0.1"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it("sees through an IPv4 address wearing an IPv6 coat", () => {
    // The classic bypass: a v4 loopback reaching a v6 socket.
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateHost("[::ffff:169.254.169.254]")).toBe(true);
    expect(isPrivateHost("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateHost("::ffff:93.184.216.34")).toBe(false);
  });

  it("catches unique-local and multicast IPv6", () => {
    expect(isPrivateHost("fc00::1")).toBe(true);
    expect(isPrivateHost("fd12:3456::1")).toBe(true);
    expect(isPrivateHost("ff02::1")).toBe(true);
    expect(isPrivateHost("2606:4700:4700::1111")).toBe(false);
  });

  it("catches names only a local resolver knows", () => {
    for (const host of ["printer.local", "db.internal", "wiki.intranet", "nas.lan", "router.home.arpa"]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("lets the ordinary web through", () => {
    for (const host of ["example.com", "www.amazon.com", "sub.domain.example.co.uk", "93.184.216.34"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it("ignores the shapes a URL parser leaves behind", () => {
    // `URL.hostname` keeps IPv6 bracketed, lowercases, and may keep a root dot.
    expect(isPrivateHost("LOCALHOST")).toBe(true);
    expect(isPrivateHost("localhost.")).toBe(true);
    expect(isPrivateHost("")).toBe(true);
  });

  it("agrees with what URL parsing normalises an address into", () => {
    // Octal, hex, and integer forms of 127.0.0.1 are all normalised by the
    // URL parser before they ever reach the guard; check the pairing holds.
    for (const raw of ["http://0177.0.0.1/", "http://0x7f.0.0.1/", "http://2130706433/"]) {
      expect(isPrivateHost(new URL(raw).hostname), raw).toBe(true);
    }
  });
});
