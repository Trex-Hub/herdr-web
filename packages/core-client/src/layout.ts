// The `herdr-app` document: structure (spaces, tabs, panes) as the desktop app keeps it in a
// core document per machine. Read-only here; see research/herdr-app-document.md.

export type PaneLayout =
  | { id: string; kind: "terminal"; terminal: string }
  /** A pane with no terminal: a mod pane (`mod` names it) or another kind of content. */
  | { id: string; kind: "other"; mod: string | null };

export interface TabLayout {
  id: string;
  /** Empty when the tab is unnamed (the desktop numbers it by position). */
  name: string;
  /** Panes in tree order (depth first); split geometry is dropped. */
  panes: PaneLayout[];
}

export interface SpaceLayout {
  id: string;
  name: string;
  folder: string;
  tabs: TabLayout[];
}

/**
 * - `ok`: the document was read and understood.
 * - `empty`: no document has been written on that machine yet.
 * - `unavailable`: it could not be read or understood; `reason` says why. `spaces` is empty.
 */
export type LayoutStatus = "ok" | "empty" | "unavailable";

export interface MachineLayout {
  /** null: the core this client is connected to; otherwise the machine's name there. */
  machine: string | null;
  status: LayoutStatus;
  reason: string | null;
  /** The document's version when read; null when it was not read. */
  version: number | null;
  spaces: SpaceLayout[];
}

export const LAYOUT_DOCUMENT = "herdr-app";

export function unavailableLayout(machine: string | null, reason: string): MachineLayout {
  return { machine, status: "unavailable", reason, version: null, spaces: [] };
}

class Unreadable extends Error {}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Turn a `doc.get` result into a layout. Never throws: an unwritten document is `empty`,
 * and anything unreadable (not an object, an unknown node type, a block with content we do
 * not know) is `unavailable` with the reason, as the desktop app treats it.
 *
 * Addresses in a remote machine's document are local to it (`t7`); they are qualified
 * with the machine name (`cachyos/t7`). Space, tab and pane ids stay as written.
 */
export function parseLayout(machine: string | null, value: unknown, version: number | null | undefined): MachineLayout {
  const v = typeof version === "number" ? version : null;
  if (value === null) return { machine, status: "empty", reason: "no layout document written yet", version: v, spaces: [] };
  try {
    return { machine, status: "ok", reason: null, version: v, spaces: readSpaces(machine, value) };
  } catch (err) {
    const reason = err instanceof Unreadable ? err.message : "unreadable layout document";
    return { machine, status: "unavailable", reason, version: v, spaces: [] };
  }
}

function readSpaces(machine: string | null, doc: unknown): SpaceLayout[] {
  if (!isObj(doc)) throw new Unreadable("layout document is not an object");
  const spaces = doc["spaces"];
  if (spaces === undefined) return [];
  if (!Array.isArray(spaces)) throw new Unreadable("layout document: spaces is not a list");
  return spaces.map((space) => {
    if (!isObj(space)) throw new Unreadable("layout document: a space is not an object");
    const tabs = space["tabs"] ?? [];
    if (!Array.isArray(tabs)) throw new Unreadable("layout document: a space's tabs is not a list");
    return {
      id: str(space["id"]),
      name: str(space["name"]),
      folder: str(space["folder"]),
      tabs: tabs.map((tab) => {
        if (!isObj(tab)) throw new Unreadable("layout document: a tab is not an object");
        const panes: PaneLayout[] = [];
        // A tab without a root is the app's empty default: no panes.
        if (tab["root"] !== undefined) collectPanes(machine, tab["root"], panes);
        return { id: str(tab["id"]), name: str(tab["name"]), panes };
      }),
    };
  });
}

function collectPanes(machine: string | null, node: unknown, out: PaneLayout[]): void {
  if (!isObj(node)) throw new Unreadable("layout document: a node is not an object");
  const id = str(node["id"]);
  switch (node["type"]) {
    case "row":
    case "column":
    case "stack": {
      const children = node["children"] ?? [];
      if (!Array.isArray(children)) throw new Unreadable(`layout document: ${String(node["type"])} children is not a list`);
      for (const child of children) collectPanes(machine, child, out);
      return;
    }
    case "block": {
      const content = node["content"];
      if (!isObj(content)) throw new Unreadable("layout document: a block has no content");
      if (typeof content["terminal"] === "string") {
        const address = content["terminal"];
        out.push({ id, kind: "terminal", terminal: machine === null ? address : `${machine}/${address}` });
      } else if (typeof content["mod"] === "string") {
        out.push({ id, kind: "other", mod: content["mod"] });
      } else if ("tab" in content || "agent" in content) {
        out.push({ id, kind: "other", mod: null });
      } else {
        throw new Unreadable("layout document: a block has content of an unknown kind");
      }
      return;
    }
    default:
      throw new Unreadable(`layout document: unknown node type ${JSON.stringify(node["type"] ?? null)}`);
  }
}
