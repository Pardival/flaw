import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KEYSTROKE_BUDGET_MS,
  MARGIN_CM,
  MODE_FORMATS,
  NOVEL_WORDS,
  PAGE_FORMATS,
  PHONE_SLOWDOWN,
  applyCharacter,
  buildNovel,
  createEditorState,
  createModel,
  defaultFormat,
  formatsForMode,
  insertChapter,
  levelFromP95,
  measureChapter,
  modelOf,
  pageGeometry,
  percentile,
  placeCaret,
  runningHead,
  selectionParentName,
  totalWords,
  withModel,
  SCHEMA_VERSION,
} from "../dist/pagination.js";

test("le schéma importé reste la version provisoire 1", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test("les formats et les défauts suivent le tableau des modes", () => {
  assert.deepEqual(formatsForMode("novel"), [
    "novel_13x20",
    "pocket_11x17_8",
    "trade_15x23",
    "a5",
  ]);
  assert.equal(defaultFormat("novel"), "novel_13x20");
  assert.deepEqual(formatsForMode("screenplay"), ["us_letter", "a4"]);
  assert.equal(defaultFormat("screenplay"), MODE_FORMATS.screenplay.defaultFormat);
  assert.deepEqual(formatsForMode("document"), ["a4", "us_letter"]);
  assert.equal(defaultFormat("document"), "a4");
  assert.equal(defaultFormat("blank"), "a4");
  assert.deepEqual(formatsForMode("blank"), [
    "a4",
    "novel_13x20",
    "pocket_11x17_8",
    "trade_15x23",
    "a5",
    "us_letter",
  ]);
  assert.deepEqual([...formatsForMode("blank")].sort(), Object.keys(PAGE_FORMATS).sort());
  assert.equal(PAGE_FORMATS.novel_13x20.widthCm, 13);
  assert.equal(PAGE_FORMATS.novel_13x20.heightCm, 20);
  assert.equal(PAGE_FORMATS.pocket_11x17_8.heightCm, 17.8);
  assert.equal(PAGE_FORMATS.a5.widthCm, 14.8);
  assert.equal(PAGE_FORMATS.a4.heightCm, 29.7);
  assert.equal(PAGE_FORMATS.us_letter.widthCm, 21.59);
});

test("le téléphone est fluide, la tablette garde les proportions du format", () => {
  const phone = pageGeometry("novel_13x20", "phone");
  const tablet = pageGeometry("novel_13x20", "tablet");
  assert.equal(phone.fluid, true);
  assert.equal(phone.markedBreaks, true);
  assert.equal(tablet.fluid, false);
  assert.equal(tablet.markedBreaks, true);
  const format = PAGE_FORMATS.novel_13x20;
  const ratio = tablet.pageWidthPx / tablet.pageHeightPx;
  assert.ok(Math.abs(ratio - format.widthCm / format.heightCm) < 1e-9);
  assert.ok(tablet.contentWidthPx < tablet.pageWidthPx);
  assert.ok(tablet.contentHeightPx < tablet.pageHeightPx);
  assert.equal(MARGIN_CM.prose.left, 1.5);
});

test("le titre du livre n'est pas un titre de chapitre", () => {
  const doc = buildNovel(240, 80);
  const geometry = pageGeometry("novel_13x20", "phone");
  const model = createModel(doc, geometry);
  assert.equal(model.bookTitle, "Manuscrit");
  assert.ok(model.chapters.length >= 2);
  for (const chapter of model.chapters) {
    assert.notEqual(chapter.title, model.bookTitle);
    assert.match(chapter.title, /^Chapitre /);
  }
  const head = runningHead(model, model.chapters[0].from + 1);
  assert.equal(head.bookTitle, "Manuscrit");
  assert.equal(head.chapterTitle, "Chapitre 1");
  assert.equal(head.folio, "…");
});

test("un roman de 150 000 mots se compte bloc par bloc", () => {
  const doc = buildNovel(NOVEL_WORDS);
  const model = createModel(doc, pageGeometry("novel_13x20", "phone"));
  assert.equal(totalWords(model.counts), NOVEL_WORDS);
  assert.ok(doc.childCount > 1000);
});

test("une frappe ne recompte qu'un bloc et ne remesure pas les chapitres", () => {
  const doc = buildNovel(240, 80);
  const geometry = pageGeometry("novel_13x20", "tablet");
  let caret = 1;
  let hits = 0;
  doc.descendants((node, pos) => {
    if (!node.isText || node.text === undefined) return;
    const local = node.text.indexOf("fenetre");
    if (local < 0) return;
    hits += 1;
    if (hits < 8) return;
    caret = pos + local + 3;
    return false;
  });
  let state = placeCaret(createEditorState(doc, geometry), caret);
  const edited = modelOf(state).dirtyChapter;
  assert.ok(edited !== null && edited > 0);
  state = withModel(state, measureChapter(modelOf(state), state.doc, 0));
  const measured = modelOf(state);
  assert.equal(measured.chapters[0].status, "measured");
  assert.equal(measured.chapters[edited].status, "estimated");
  const typed = applyCharacter(state, " ");
  const after = modelOf(typed.state);
  assert.equal(after.chapters[0].status, "measured");
  assert.equal(after.chapters[edited].status, "estimated");
  assert.equal(after.dirtyChapter, edited);
  const changedIndexes = [];
  for (let index = 0; index < after.counts.length; index += 1) {
    if (after.counts[index] !== measured.counts[index]) changedIndexes.push(index);
  }
  assert.equal(changedIndexes.length, 1);
  const block = changedIndexes[0];
  assert.equal(after.counts[block], measured.counts[block] + 1);
  assert.ok(block >= after.chapters[edited].blockStart);
  assert.ok(block < after.chapters[edited].blockEnd);
  let replaced = 0;
  state.doc.forEach((node, _offset, index) => {
    if (node !== typed.state.doc.child(index)) replaced += 1;
  });
  assert.equal(replaced, 1);
  const head = runningHead(after, after.chapters[edited].from + 1);
  assert.equal(head.folio, "…");
  assert.notEqual(head.chapterTitle, head.bookTitle);
  const numbered = runningHead(after, after.chapters[0].from + 1);
  assert.equal(typeof numbered.folio, "number");
});

test("insérer un chapitre ouvre une page et place le curseur dans le titre", () => {
  const doc = buildNovel(240, 80);
  const geometry = pageGeometry("novel_13x20", "tablet");
  let state = withModel(
    placeCaret(createEditorState(doc, geometry), 20),
    measureChapter(modelOf(createEditorState(doc, geometry)), doc, 0),
  );
  const before = modelOf(state).chapters.length;
  state = insertChapter(state);
  assert.equal(selectionParentName(state), "chapter_title");
  const model = modelOf(state);
  assert.equal(model.chapters.length, before + 1);
  const inserted = model.chapters.find((chapter) => chapter.title === "");
  assert.ok(inserted);
  assert.equal(inserted.status, "estimated");
  assert.equal(model.chapters[0].status, "measured");
  const measured = measureChapter(model, state.doc, inserted.index);
  assert.equal(measured.chapters[inserted.index].pages[0].pos, inserted.from);
  assert.equal(state.doc.nodeAt(inserted.from)?.type.name, "chapter_title");
});

test("le modèle d'une frappe sur 150 000 mots reste sous 16 ms", () => {
  const doc = buildNovel(NOVEL_WORDS);
  const geometry = pageGeometry("novel_13x20", "phone");
  let state = placeCaret(createEditorState(doc, geometry), Math.floor(doc.content.size / 2));
  const index = modelOf(state).dirtyChapter ?? 0;
  state = withModel(state, measureChapter(modelOf(state), state.doc, index));
  for (let warmup = 0; warmup < 5; warmup += 1) state = applyCharacter(state, "e").state;
  const samples = [];
  for (let indexSample = 0; indexSample < 30; indexSample += 1) {
    const typed = applyCharacter(state, "e");
    state = typed.state;
    samples.push(typed.syncMs);
  }
  const p95 = percentile(samples, 95);
  assert.ok(p95 < KEYSTROKE_BUDGET_MS, `p95 modèle ${p95} ms`);
  assert.equal(levelFromP95(5), 1);
  assert.equal(levelFromP95(5.4), 2);
  assert.equal(PHONE_SLOWDOWN, 3);
});
