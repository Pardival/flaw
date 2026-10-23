export {
  ACCESS_DENIED,
  ACCESS_GRANTED,
  DOCUMENT_ACTIONS,
  can,
  validActor,
  type AccessActor,
  type AccessTarget,
  type CanResult,
  type DocumentAction,
} from "./can.ts";
export {
  deleteOwnedDocument,
  exportDocument,
  listOwnedDocuments,
  patchDocument,
  readDocument,
  updateDocument,
} from "./documents.ts";
export { registerContentRoutes, type ContentRouteDeps } from "./rest.ts";
export { documentFontSchema, documentRefSchema, syncBodySchema } from "./schema.ts";
export { withActor } from "./scope.ts";
export { syncDocument } from "./sync.ts";
