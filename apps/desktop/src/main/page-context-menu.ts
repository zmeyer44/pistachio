/**
 * The page context menu moved to `@pistachio/shell-contracts` in S6 so the
 * cloud shell host builds the same menu from the same pure code
 * (docs/web-browser-design.md §11). Main keeps this name for the modules and
 * the test that already import it.
 */

export * from "@pistachio/shell-contracts/page-context-menu";
