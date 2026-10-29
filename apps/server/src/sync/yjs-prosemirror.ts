/**
 * Lecture du fragment Yjs `content` au format de y-prosemirror, sans dépendance au DOM :
 * Y.XmlElement = nœud (nodeName, attributs), Y.XmlText = texte avec marques en attributs.
 * Le JSON obtenu passe ensuite par documentFromJson (SEC-DATA-02).
 */
import * as Y from "yjs";

type MarkJson = { type: string; attrs?: Record<string, unknown> };
type NodeJson = { type: string; attrs?: Record<string, unknown>; content?: NodeJson[]; text?: string; marks?: MarkJson[] };

function marksOf(attributes: Record<string, unknown> | undefined): MarkJson[] {
  if (attributes === undefined) {
    return [];
  }
  return Object.entries(attributes).map(([name, value]) => {
    // y-prosemirror suffixe `--hash` les marques superposables.
    const type = name.replace(/--[^-]*$/u, "");
    return value !== null && typeof value === "object" && Object.keys(value).length > 0
      ? { type, attrs: value as Record<string, unknown> }
      : { type };
  });
}

function textRuns(text: Y.XmlText): NodeJson[] {
  const runs: NodeJson[] = [];
  for (const op of text.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
    if (typeof op.insert !== "string" || op.insert.length === 0) {
      continue;
    }
    const marks = marksOf(op.attributes);
    runs.push(marks.length > 0 ? { type: "text", text: op.insert, marks } : { type: "text", text: op.insert });
  }
  return runs;
}

function children(parent: Y.XmlElement | Y.XmlFragment): NodeJson[] {
  const out: NodeJson[] = [];
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) {
      out.push(...textRuns(child));
    } else if (child instanceof Y.XmlElement) {
      out.push(elementJson(child));
    }
  }
  return out;
}

function elementJson(element: Y.XmlElement): NodeJson {
  const node: NodeJson = { type: element.nodeName };
  const attrs = element.getAttributes() as Record<string, unknown>;
  if (Object.keys(attrs).length > 0) {
    node.attrs = attrs;
  }
  const content = children(element);
  if (content.length > 0) {
    node.content = content;
  }
  return node;
}

/** `undefined` si le fragment est vide (texte jamais ouvert dans l'éditeur). */
export function fragmentToProseMirrorJson(fragment: Y.XmlFragment): NodeJson | undefined {
  const content = children(fragment);
  if (content.length === 0) {
    return undefined;
  }
  return { type: "doc", content };
}
