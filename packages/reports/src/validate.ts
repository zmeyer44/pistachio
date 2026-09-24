/**
 * Strict validation of a report spec against the catalog.
 *
 * json-render's own `catalog.validate` checks the tree's shape but not the
 * props, and a spec is read back from disk and handed to React — so both main
 * (before it stores one) and the renderer (before it draws one) run this. It
 * answers one question: is every element something the catalog defines, filled
 * with props that component accepts, wired only to actions the catalog names?
 */
import { resolveElementProps, validateSpec, type Spec } from "@json-render/core";
import { reportCatalog } from "./catalog.js";

export const MAX_REPORT_ELEMENTS = 64;
export const MAX_REPORT_BYTES = 512_000;

export type ReportSpecCheck = { ok: true; spec: Spec } | { ok: false; issues: string[] };

interface Definition {
  props: { safeParse(value: unknown): { success: boolean } };
  slots?: readonly string[];
  events?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function validateReportSpec(value: unknown): ReportSpecCheck {
  const issues: string[] = [];
  if (!isRecord(value) || typeof value["root"] !== "string" || !isRecord(value["elements"]))
    return { ok: false, issues: ["The spec is not a root and an elements map."] };
  let bytes = 0;
  try {
    bytes = JSON.stringify(value).length;
  } catch {
    return { ok: false, issues: ["The spec cannot be serialized."] };
  }
  if (bytes > MAX_REPORT_BYTES) return { ok: false, issues: ["The spec is too large."] };

  const elements = value["elements"];
  const ids = Object.keys(elements);
  if (ids.length > MAX_REPORT_ELEMENTS) return { ok: false, issues: ["The spec has too many elements."] };
  const state = isRecord(value["state"]) ? value["state"] : {};
  const components = reportCatalog.data.components as Record<string, Definition>;
  const actions = reportCatalog.data.actions as Record<string, { params: Definition["props"] }>;

  for (const id of ids) {
    const element = elements[id];
    if (!isRecord(element) || typeof element["type"] !== "string" || !isRecord(element["props"])) {
      issues.push(`${id}: not an element.`);
      continue;
    }
    const definition = Object.hasOwn(components, element["type"]) ? components[element["type"]] : undefined;
    if (definition === undefined) {
      issues.push(`${id}: unknown component ${element["type"]}.`);
      continue;
    }
    if (!definition.props.safeParse(resolveElementProps(element["props"], { stateModel: state })).success)
      issues.push(`${id}: props do not fit ${element["type"]}.`);

    const slots = definition.slots ?? [];
    const children = element["children"] ?? [];
    if (!stringList(children)) issues.push(`${id}: children is not a list of ids.`);
    else if (children.length > 0 && !slots.includes("default")) issues.push(`${id}: ${element["type"]} takes no children.`);
    if (element["slots"] !== undefined) {
      if (!isRecord(element["slots"])) issues.push(`${id}: slots is not a map.`);
      else
        for (const [slot, members] of Object.entries(element["slots"])) {
          if (!slots.includes(slot)) issues.push(`${id}: ${element["type"]} has no slot ${slot}.`);
          if (!stringList(members)) issues.push(`${id}: slot ${slot} is not a list of ids.`);
          else for (const member of members) if (!Object.hasOwn(elements, member)) issues.push(`${id}: slot ${slot} names a missing element.`);
        }
    }
    // A report never repeats over state or hides elements: the app decided what is in it.
    if (element["repeat"] !== undefined || element["visible"] !== undefined || element["watch"] !== undefined)
      issues.push(`${id}: repeat, visible and watch are not used in reports.`);

    if (element["on"] !== undefined) {
      if (!isRecord(element["on"])) issues.push(`${id}: on is not a map.`);
      else
        for (const [event, bound] of Object.entries(element["on"])) {
          if (!(definition.events ?? []).includes(event)) issues.push(`${id}: ${element["type"]} has no event ${event}.`);
          for (const binding of Array.isArray(bound) ? bound : [bound]) {
            const name = isRecord(binding) ? binding["action"] : undefined;
            const action = typeof name === "string" && Object.hasOwn(actions, name) ? actions[name] : undefined;
            if (action === undefined || !isRecord(binding)) issues.push(`${id}: unknown action.`);
            else if (!action.params.safeParse(binding["params"] ?? {}).success) issues.push(`${id}: bad parameters for ${String(name)}.`);
            else if (Object.keys(binding).some((key) => key !== "action" && key !== "params")) issues.push(`${id}: only action and params may be bound.`);
          }
        }
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // A tree, not a graph: a cycle would hang the renderer.
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) {
      issues.push(`${id}: appears twice in the tree.`);
      return;
    }
    seen.add(id);
    const element = elements[id] as Record<string, unknown> | undefined;
    if (element === undefined) {
      issues.push(`${id}: missing element.`);
      return;
    }
    const slots = isRecord(element["slots"]) ? Object.values(element["slots"]) : [];
    for (const member of [...((element["children"] as string[] | undefined) ?? []), ...(slots as string[][]).flat()]) visit(member);
  };
  visit(value["root"]);
  if (issues.length > 0) return { ok: false, issues };

  const structure = validateSpec(value as unknown as Spec, { checkOrphans: true });
  const errors = structure.issues.filter((issue) => issue.severity === "error" || issue.code === "orphaned_element");
  if (errors.length > 0) return { ok: false, issues: errors.map((issue) => issue.message) };
  return { ok: true, spec: value as unknown as Spec };
}
