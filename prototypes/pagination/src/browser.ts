import type { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import {
  KEYSTROKE_BUDGET_MS,
  NOVEL_WORDS,
  PHONE_SLOWDOWN,
  applyCharacter,
  buildNovel,
  createEditorState,
  levelFromP95,
  measureChapter,
  measureChapters,
  modelOf,
  pageGeometry,
  percentile,
  schema,
  textPositionNear,
  withModel,
} from "./index.ts";

type Summary = { p50: number; p95: number; max: number };

function summarize(samples: readonly number[]): Summary {
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: Math.max(...samples),
  };
}

function styleFor(surface: "phone" | "tablet", widthPx: number): string {
  const column = surface === "phone" ? "width: 100%;" : `width: ${widthPx}px; margin: 0 auto;`;
  return `
    body { margin: 0; font-family: "Liberation Serif", "Times New Roman", serif; }
    #column { ${column} }
    .ProseMirror { font-size: 11pt; line-height: 1.45; padding: 0 12px 2rem; outline: none; }
    .ProseMirror > * { content-visibility: auto; contain-intrinsic-size: auto 1.6em; }
    .ProseMirror p, .ProseMirror [data-flaw-node] { margin: 0; }
    .flaw-page-break {
      display: block;
      margin: 0.75rem 0;
      border-top: 1px solid #b9b3a7;
      color: #6d675c;
      font-family: sans-serif;
      font-size: 12px;
      line-height: 1.4rem;
      content-visibility: visible;
    }
    #head { font-family: sans-serif; font-size: 13px; padding: 0.5rem 12px; }
  `;
}

function mount(state: EditorState, surface: "phone" | "tablet", widthPx: number): EditorView {
  document.body.replaceChildren();
  const style = document.createElement("style");
  style.textContent = styleFor(surface, widthPx);
  const head = document.createElement("div");
  head.id = "head";
  const column = document.createElement("div");
  column.id = "column";
  const host = document.createElement("div");
  host.id = "editor";
  column.append(host);
  document.body.append(style, head, column);
  const view = new EditorView(host, {
    state,
    dispatchTransaction(transaction) {
      view.updateState(view.state.apply(transaction));
    },
  });
  return view;
}

function caretElement(view: EditorView): Element | null {
  const found = view.domAtPos(view.state.selection.from);
  if (found.node instanceof Element) return found.node;
  return found.node.parentElement;
}

/**
 * `sync` : transaction, compteur, décorations, mise à jour DOM.
 * `layout` : la même chose plus le rectangle du bloc du curseur
 * (ce que le navigateur fait pour placer le caret). L'attente du
 * prochain frame n'est pas comptée : elle vaut ~16 ms même à vide.
 */
async function timeKeystrokes(view: EditorView, count: number): Promise<{ sync: number[]; layout: number[] }> {
  const sync: number[] = [];
  const layout: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    const next = applyCharacter(view.state, "e");
    view.updateState(next.state);
    sync.push(performance.now() - started);
    caretElement(view)?.getBoundingClientRect();
    layout.push(performance.now() - started);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  return { sync, layout };
}

function place(state: EditorState, target: number): EditorState {
  const pos = textPositionNear(state.doc, target);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

function contentVisibilityOf(view: EditorView): string {
  const paragraph = view.dom.querySelector("p");
  if (paragraph === null) return "absent";
  return getComputedStyle(paragraph).contentVisibility;
}

export async function runBench(): Promise<Record<string, unknown>> {
  const samples = 40;
  const warmup = 5;
  const doc = buildNovel(NOVEL_WORDS);
  const phone = pageGeometry("novel_13x20", "phone");
  const tablet = pageGeometry("novel_13x20", "tablet");
  let state = place(createEditorState(doc, phone), Math.floor(doc.content.size / 2));
  const middle = modelOf(state).dirtyChapter ?? 0;
  state = withModel(state, measureChapter(modelOf(state), state.doc, middle));

  const view = mount(state, "phone", phone.pageWidthPx);
  const visibility = contentVisibilityOf(view);
  const before = view.state.doc.textContent.length;
  await timeKeystrokes(view, warmup);
  const phoneSamples = await timeKeystrokes(view, samples);
  const phoneSummary = summarize(phoneSamples.layout);
  const phoneSync = summarize(phoneSamples.sync);
  const after = view.state.doc.textContent.length;
  const editingOk = after === before + warmup + samples;
  const head = document.getElementById("head");
  if (head !== null) {
    const model = modelOf(view.state);
    head.textContent = `${model.bookTitle} · chapitre mesuré ${middle} · ${model.chapters.length} chapitres`;
  }
  view.destroy();

  let tabletState = place(createEditorState(doc, tablet), Math.floor(doc.content.size / 2));
  tabletState = withModel(
    tabletState,
    measureChapter(modelOf(tabletState), tabletState.doc, modelOf(tabletState).dirtyChapter ?? 0),
  );
  const tabletView = mount(tabletState, "tablet", tablet.pageWidthPx);
  await timeKeystrokes(tabletView, warmup);
  const tabletTimed = await timeKeystrokes(tabletView, samples);
  const tabletSummary = summarize(tabletTimed.layout);
  tabletView.destroy();

  const allIndexes = modelOf(state).chapters.map((chapter) => chapter.index);
  let stressed = place(createEditorState(doc, phone), Math.floor(doc.content.size / 2));
  stressed = withModel(stressed, measureChapters(modelOf(stressed), stressed.doc, allIndexes));
  const stressView = mount(stressed, "phone", phone.pageWidthPx);
  await timeKeystrokes(stressView, warmup);
  const stressTimed = await timeKeystrokes(stressView, samples);
  const stressSummary = summarize(stressTimed.layout);
  const decorated = modelOf(stressView.state).decorations.find().length;
  stressView.destroy();

  const chapter = modelOf(state).chapters[middle];
  if (chapter === undefined) throw new Error("chapitre milieu absent");
  const slice: PMNode[] = [];
  state.doc.forEach((node, _offset, index) => {
    if (index >= chapter.blockStart && index < chapter.blockEnd) slice.push(node);
  });
  const chapterDoc = schema.node("doc", null, slice);
  let level2 = createEditorState(chapterDoc, phone);
  level2 = withModel(level2, measureChapter(modelOf(level2), level2.doc, 0));
  const level2View = mount(level2, "phone", phone.pageWidthPx);
  await timeKeystrokes(level2View, warmup);
  const level2Timed = await timeKeystrokes(level2View, samples);
  const level2Summary = summarize(level2Timed.layout);
  level2View.destroy();

  const decision = levelFromP95(phoneSummary.p95);
  return {
    words: NOVEL_WORDS,
    blocks: doc.childCount,
    chapters: modelOf(state).chapters.length,
    surface: "phone",
    samples,
    contentVisibility: visibility,
    editingOk,
    phoneSync,
    phone: phoneSummary,
    tablet: tabletSummary,
    allChaptersDecorated: { ...stressSummary, decorations: decorated },
    level2Chapter: level2Summary,
    phoneFactor: PHONE_SLOWDOWN,
    budgetMs: KEYSTROKE_BUDGET_MS,
    projectedPhoneP95Ms: phoneSummary.p95 * PHONE_SLOWDOWN,
    decision,
  };
}

void runBench()
  .then((report) => {
    const pre = document.createElement("pre");
    pre.id = "result";
    pre.textContent = JSON.stringify(report);
    document.body.append(pre);
  })
  .catch((error: unknown) => {
    const pre = document.createElement("pre");
    pre.id = "result";
    const message = error instanceof Error ? error.message : "banc interrompu";
    pre.textContent = JSON.stringify({ error: message });
    document.body.append(pre);
  });
