/**
 * "Works in Pistachio" (docs/extensions.md §2, §6.4): a curated slice of popular Chrome Web Store extensions, added
 * by id with no visit to the store, each with the verdict we hold for it. It overrides the static read of the
 * manifest (verdict.ts) — measured beats inferred — so each entry says only what is known:
 *
 * - Read from the extension's real manifest, downloaded from the store on 2026-10-30, against the APIs Electron
 *   43.4.1 was measured to give an extension that day (verdict.ts's header).
 * - Nothing here was yet run end to end in Pistachio; where a note depends on behaviour that wasn't watched, it says
 *   "Unverified". Password managers stay ◐ until verified by hand (§6.4).
 * - Uninstallable ids (no longer served by the store when checked) are kept with that reason, so a pasted link gets
 *   an honest answer.
 * - Each entry's logo is the one in its package (the largest of its manifest's `icons`, the picture the store's
 *   listing shows), brought into the shell's own files by `scripts/fetch-curated-icons.mjs`; an id the store no
 *   longer serves has none, and the page draws its monogram.
 */

import type { ChromeVerdict, ExtensionCuratedEntry } from "@pistachio/shell-contracts/extensions";
import { chromeVerdict, type ChromeManifest, type ChromeVerdictOptions } from "./verdict";

const SHIELDS: ChromeVerdict = { kind: "wont", reason: "Shields already blocks ads and trackers here.", alternative: "Shields" };

/** A curated extension's logo, among the shell's static files (src/renderer/public/extension-icons/). */
const logo = (cwsId: string): string => `/extension-icons/${cwsId}.png`;

export const CURATED_CHROME: ExtensionCuratedEntry[] = [
  {
    cwsId: "eimadpbcbfnmbkopoojfekhnkhdbieeh",
    iconUrl: logo("eimadpbcbfnmbkopoojfekhnkhdbieeh"),
    name: "Dark Reader",
    description: "Dark mode for every website.",
    verdict: { kind: "partly", notes: ["Its keyboard shortcuts aren't available yet.", "It can't list your fonts here, so its font choice is limited."] },
  },
  {
    cwsId: "kbfnbcaeplbcioakkpcpgfkobkghlhen",
    iconUrl: logo("kbfnbcaeplbcioakkpcpgfkobkghlhen"),
    name: "Grammarly",
    description: "Grammar, spelling and tone suggestions as you write.",
    verdict: {
      kind: "partly",
      notes: [
        "It works in web pages, not in Pistachio's own Notes or chat.",
        "Its side panel doesn't open here yet.",
        "Signing in from its pop-up may not work; signing in on grammarly.com does. Unverified.",
      ],
    },
  },
  {
    cwsId: "nngceckbapebfimnlniiiahkandclblb",
    iconUrl: logo("nngceckbapebfimnlniiiahkandclblb"),
    name: "Bitwarden",
    description: "A password manager: fill, save and generate passwords.",
    verdict: {
      kind: "partly",
      notes: [
        "Signing in works; unlocking with the desktop app isn't available in Pistachio yet.",
        "Its side panel and keyboard shortcuts aren't available yet.",
      ],
    },
  },
  {
    cwsId: "aeblfdkhhhdcdjpifhhbdiojplfjncoa",
    iconUrl: logo("aeblfdkhhhdcdjpifhhbdiojplfjncoa"),
    name: "1Password",
    description: "A password manager: fill, save and generate passwords.",
    verdict: {
      kind: "partly",
      notes: ["Signing in works; unlocking with the 1Password app isn't available in Pistachio yet.", "Its keyboard shortcut isn't available yet. Unverified."],
    },
  },
  {
    cwsId: "fmkadmapgofadopljbjfkapdkoienihi",
    iconUrl: logo("fmkadmapgofadopljbjfkapdkoienihi"),
    name: "React Developer Tools",
    description: "Components and Profiler panels in the developer tools.",
    verdict: { kind: "works" },
  },
  {
    cwsId: "nhdogjmejiglipccpnnnanhbledajbpd",
    iconUrl: logo("nhdogjmejiglipccpnnnanhbledajbpd"),
    name: "Vue.js devtools",
    description: "Inspect Vue components and state in the developer tools.",
    verdict: { kind: "works" },
  },
  {
    cwsId: "lmhkpmbekcpmknklioeibfkpmmfibljd",
    iconUrl: logo("lmhkpmbekcpmknklioeibfkpmmfibljd"),
    name: "Redux DevTools",
    description: "Watch and replay Redux state in the developer tools.",
    verdict: { kind: "partly", notes: ["Its keyboard shortcuts aren't available yet."] },
  },
  {
    cwsId: "knheggckgoiihginacbkhaalnibhilkk",
    iconUrl: logo("knheggckgoiihginacbkhaalnibhilkk"),
    name: "Notion Web Clipper",
    description: "Save any page to your Notion workspace.",
    verdict: { kind: "works" },
  },
  {
    cwsId: "niloccemoadcdkdjlinkgdfekeahmflj",
    iconUrl: null,
    name: "Pocket",
    description: "Save articles to read later.",
    verdict: { kind: "wont", reason: "Pocket shut down in 2025, and the store no longer offers it." },
  },
  {
    cwsId: "ldgfbffkinooeloadekpmfoklnobpien",
    iconUrl: logo("ldgfbffkinooeloadekpmfoklnobpien"),
    name: "Raindrop.io",
    description: "Save pages and links to your Raindrop collections.",
    verdict: { kind: "partly", notes: ["Its side panel doesn't open here yet.", "Its address-bar keyword and keyboard shortcuts don't work here."] },
  },
  {
    cwsId: "jldhpllghnbhlbpcmnajkpdmadaolakh",
    iconUrl: logo("jldhpllghnbhlbpcmnajkpdmadaolakh"),
    name: "Todoist",
    description: "Add tasks from any page, and see your Todoist list.",
    verdict: {
      kind: "partly",
      notes: ["Its keyboard shortcuts aren't available yet."],
    },
  },
  {
    cwsId: "liecbddmkiiihnedobmlmillhodjkdmb",
    iconUrl: logo("liecbddmkiiihnedobmlmillhodjkdmb"),
    name: "Loom",
    description: "Record your screen and camera, and share a link.",
    verdict: { kind: "wont", reason: "It records your screen or tabs through Chrome's capture APIs, which Pistachio doesn't give extensions.", alternative: "Recorder" },
  },
  {
    cwsId: "bmnlcjabgnpnenekpadlanbbkooimhnj",
    iconUrl: logo("bmnlcjabgnpnenekpadlanbbkooimhnj"),
    name: "Honey",
    description: "Finds coupon codes when you shop.",
    verdict: { kind: "works" },
  },
  {
    cwsId: "bcjindcccaagfpapjjmafapmmgkkhgoa",
    iconUrl: logo("bcjindcccaagfpapjjmafapmmgkkhgoa"),
    name: "JSON Formatter",
    description: "Pretty-prints JSON in the page.",
    verdict: { kind: "works" },
  },
  {
    cwsId: "gppongmhjkpfnbhagpmjfkannfbllamg",
    iconUrl: logo("gppongmhjkpfnbhagpmjfkannfbllamg"),
    name: "Wappalyzer",
    description: "Shows the technologies a site is built with.",
    verdict: { kind: "partly", notes: ["It reads response headers through webRequest, which Pistachio's own request filter may answer first. Unverified."] },
  },
  {
    cwsId: "cjpalhdlnbpafiamejdnhcphjbkeiagm",
    iconUrl: null,
    name: "uBlock Origin",
    description: "A content blocker (no longer offered for Chrome).",
    verdict: SHIELDS,
  },
  {
    cwsId: "ddkjiahejlhfcafbddmgiahcphecmpfh",
    iconUrl: logo("ddkjiahejlhfcafbddmgiahcphecmpfh"),
    name: "uBlock Origin Lite",
    description: "A content blocker built on declarativeNetRequest.",
    verdict: SHIELDS,
  },
  {
    cwsId: "laookkfknpbbblfpciffpaejjkokdgca",
    iconUrl: logo("laookkfknpbbblfpciffpaejjkokdgca"),
    name: "Momentum",
    description: "A new tab page with a photo, a focus and your to-dos.",
    verdict: { kind: "partly", notes: ["New tabs keep opening Pistachio's home page."] },
  },
  {
    cwsId: "dbepggeogbaibhgnhhndojpepiihcmeb",
    iconUrl: logo("dbepggeogbaibhgnhhndojpepiihcmeb"),
    name: "Vimium",
    description: "Browse with the keyboard, Vim-style.",
    verdict: {
      kind: "partly",
      notes: ["It can't search your bookmarks or history here.", "Its keys work in web pages, not in Pistachio's own pages. Unverified."],
    },
  },
  {
    cwsId: "dhdgffkkebhmkfjojejmpbldmpobfkfo",
    iconUrl: logo("dhdgffkkebhmkfjojejmpbldmpobfkfo"),
    name: "Tampermonkey",
    description: "Runs user scripts on the pages they name.",
    verdict: { kind: "wont", reason: "It runs your user scripts through Chrome's userScripts API, which Pistachio doesn't have yet." },
  },
  {
    cwsId: "aapbdbdomjkkjkaonfhkkikfgjllcleb",
    iconUrl: logo("aapbdbdomjkkjkaonfhkkikfgjllcleb"),
    name: "Google Translate",
    description: "Translate a selection or the whole page.",
    verdict: { kind: "works" },
  },
  {
    cwsId: "gmbmikajjgmnabiglmofipeabaddhgne",
    iconUrl: logo("gmbmikajjgmnabiglmofipeabaddhgne"),
    name: "Save to Google Drive",
    description: "Save pages, images and links to Google Drive.",
    verdict: { kind: "wont", reason: "It signs in with the Google account inside Chrome, which Pistachio doesn't have." },
  },
  {
    cwsId: "bhlhnicpbhignbdhedgjhgdocnmhomnp",
    iconUrl: logo("bhlhnicpbhignbdhedgjhgdocnmhomnp"),
    name: "ColorZilla",
    description: "An eyedropper and color picker for the page.",
    verdict: { kind: "partly", notes: ["Picking a colour from the page may not work: it takes a picture of the tab, which Pistachio doesn't give extensions yet. Unverified."] },
  },
  {
    cwsId: "ekhagklcjbdpajgpjgmbionohlpdbjgc",
    iconUrl: logo("ekhagklcjbdpajgpjgmbionohlpdbjgc"),
    name: "Zotero Connector",
    description: "Save references and PDFs to Zotero.",
    verdict: { kind: "works" },
  },
  {
    cwsId: "jjhefcfhmnkfeepcpnilbbkaadhngkbi",
    iconUrl: logo("jjhefcfhmnkfeepcpnilbbkaadhngkbi"),
    name: "Readwise Highlighter",
    description: "Highlight pages and save them to Readwise Reader.",
    verdict: { kind: "works" },
  },
  {
    cwsId: "fcoeoabgfenejglbffodgkkbkcdhcgfn",
    iconUrl: logo("fcoeoabgfenejglbffodgkkbkcdhcgfn"),
    name: "Claude",
    description: "Claude in Chrome: an agent that works in your tabs.",
    verdict: { kind: "wont", reason: "It drives pages through Chrome's debugger, which Pistachio doesn't give extensions.", alternative: "Ask Pistachio" },
  },
];

const BY_ID = new Map(CURATED_CHROME.map((entry) => [entry.cwsId, entry]));

export function curatedChrome(cwsId: string): ExtensionCuratedEntry | null {
  return BY_ID.get(cwsId) ?? null;
}

/**
 * The verdict to show: the curated one when there is one (measured beats inferred), else the manifest's — unless the
 * downloaded manifest now refuses what the entry let through: a manifest that changed for the worse since it was
 * curated is read as it is.
 */
export function verdictFor(cwsId: string, manifest: ChromeManifest, options: ChromeVerdictOptions = {}): ChromeVerdict {
  const inferred = chromeVerdict(manifest, options);
  const curated = curatedChrome(cwsId)?.verdict;
  if (curated === undefined) return inferred;
  if (inferred.kind === "wont" && curated.kind !== "wont") return inferred;
  return curated;
}
