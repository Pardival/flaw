export { SCHEMA_VERSION, schema } from "../../../packages/schema/src/index.ts";
export type { DocumentMode } from "../../../packages/schema/src/index.ts";

export {
  MARGIN_CM,
  MODE_FORMATS,
  PAGE_FORMATS,
  defaultFormat,
  formatsForMode,
  pageGeometry,
} from "./formats.ts";
export type { Geometry, PageFormatId, Surface } from "./formats.ts";

export { NOVEL_WORDS, buildNovel } from "./novel.ts";
export { countBlocks, countWords, totalWords, updateCounts } from "./words.ts";
export {
  createModel,
  integrate,
  measureChapter,
  measureChapters,
  runningHead,
  textPositionNear,
} from "./paginate.ts";
export type { ChapterModel, Folio, PageBreak, PaginationModel } from "./paginate.ts";
export {
  applyCharacter,
  createEditorState,
  insertChapter,
  modelOf,
  paginationKey,
  placeCaret,
  selectionParentName,
  withModel,
} from "./edit.ts";
export { KEYSTROKE_BUDGET_MS, PHONE_SLOWDOWN, levelFromP95, percentile } from "./stats.ts";
