import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  TextRun,
  type IParagraphOptions,
} from "docx";

import {
  DEFAULT_FONT,
  DEFAULT_SIZE,
  MARGINS_MM,
  PAGE_MM,
  SCRIPT_MARGINS_MM,
  alignOf,
  plainText,
  runsOf,
  type ExportInput,
  type PMJson,
} from "../model.ts";

/** Word (A-016, bibliothèque docx) : format, marges, police et éléments du mode. */
const TWIP_PER_MM = 1440 / 25.4;
const twip = (mm: number) => Math.round(mm * TWIP_PER_MM);
const inch = (value: number) => Math.round(value * 1440);

const ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
} as const;

function textRuns(node: PMJson, base: { font: string; sizePt: number }, upper = false): TextRun[] {
  return runsOf(node).map(
    (run) =>
      new TextRun({
        text: upper ? run.text.toUpperCase() : run.text,
        bold: run.bold,
        italics: run.italic,
        font: base.font,
        size: Math.round((run.sizePt ?? base.sizePt) * 2),
        break: run.lineBreak ? 1 : undefined,
      }),
  );
}

/** Retraits du script en pouces depuis la marge gauche (jetons --script-*). */
const SCRIPT_INDENT: Record<string, { left: number; right?: number; upper?: boolean; align?: "right" | "center" }> = {
  scene_heading: { left: 0, upper: true },
  action: { left: 0 },
  character: { left: 2.2, upper: true },
  parenthetical: { left: 1.6, right: 2.4 },
  dialogue: { left: 1, right: 1.5 },
  transition: { left: 0, upper: true, align: "right" },
  centered: { left: 0, align: "center" },
};

function paragraphs(node: PMJson, input: ExportInput, base: { font: string; sizePt: number }, state: { first: boolean }, level = 0): Paragraph[] {
  const align = alignOf(node);
  const common: IParagraphOptions = align === null ? {} : { alignment: ALIGN[align] };
  if (input.mode === "screenplay" && SCRIPT_INDENT[node.type]) {
    const spec = SCRIPT_INDENT[node.type] ?? { left: 0 };
    const spaced = node.type === "scene_heading" || node.type === "action" || node.type === "character" || node.type === "transition";
    return [
      new Paragraph({
        children: textRuns(node, base, spec.upper === true),
        indent: { left: inch(spec.left), right: spec.right === undefined ? undefined : inch(spec.right) },
        alignment: spec.align === "right" ? AlignmentType.RIGHT : spec.align === "center" ? AlignmentType.CENTER : undefined,
        spacing: { before: spaced ? 240 : 0, after: 0, line: 240 },
        keepNext: node.type === "character" || node.type === "scene_heading",
      }),
    ];
  }
  switch (node.type) {
    case "title":
      return [];
    case "chapter_title": {
      const breakBefore = !state.first;
      state.first = false;
      return [
        new Paragraph({
          children: [...(breakBefore ? [new PageBreak()] : []), ...textRuns(node, { ...base, sizePt: 20 })],
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          spacing: { before: 1200, after: 600 },
        }),
      ];
    }
    case "heading": {
      const value = node.attrs?.level;
      const heading = value === 2 ? HeadingLevel.HEADING_2 : value === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_1;
      const size = value === 2 ? 15 : value === 3 ? 12 : 20;
      return [new Paragraph({ ...common, children: textRuns(node, { ...base, sizePt: size }), heading, spacing: { before: 240, after: 120 } })];
    }
    case "scene_break":
      return [new Paragraph({ children: [new TextRun({ text: "*  *  *", font: base.font, size: base.sizePt * 2 })], alignment: AlignmentType.CENTER, spacing: { before: 240, after: 240 } })];
    case "bullet_list":
    case "ordered_list":
    case "bullet_list_2":
    case "ordered_list_2": {
      const ordered = node.type.startsWith("ordered");
      return (node.content ?? []).flatMap((item) =>
        (item.content ?? []).flatMap((child) =>
          child.type === "paragraph"
            ? [
                new Paragraph({
                  children: textRuns(child, base),
                  numbering: { reference: ordered ? "numbers" : "bullets", level },
                }),
              ]
            : paragraphs(child, input, base, state, level + 1),
        ),
      );
    }
    default: {
      const novel = input.mode === "novel";
      return [
        new Paragraph({
          ...common,
          children: textRuns(node, base),
          alignment: common.alignment ?? (novel ? AlignmentType.JUSTIFIED : undefined),
          indent: novel ? { firstLine: twip(5) } : undefined,
          spacing: novel ? { after: 0, line: 340 } : { after: 120, line: 300 },
        }),
      ];
    }
  }
}

export async function exportDocx(input: ExportInput): Promise<Uint8Array> {
  const size = PAGE_MM[input.pageFormat];
  const [top, right, bottom, left] = input.mode === "screenplay" ? SCRIPT_MARGINS_MM : MARGINS_MM[input.pageFormat];
  const base = {
    font: input.mode === "screenplay" ? "Courier Prime" : (input.fontFamily ?? DEFAULT_FONT[input.mode]),
    sizePt: input.mode === "screenplay" ? 12 : (input.baseFontSizePt ?? DEFAULT_SIZE[input.mode]),
  };
  const state = { first: true };
  const body = (input.doc.content ?? []).flatMap((node) => paragraphs(node, input, base, state));
  const titlePage =
    input.mode === "novel" || input.mode === "screenplay"
      ? [
          new Paragraph({ children: [new TextRun({ text: input.title, font: base.font, size: 56 })], alignment: AlignmentType.CENTER, spacing: { before: 3600 } }),
          ...(input.author ? [new Paragraph({ children: [new TextRun({ text: input.author, font: base.font, size: 28 })], alignment: AlignmentType.CENTER })] : []),
          new Paragraph({ children: [new PageBreak()] }),
        ]
      : [];
  const doc = new Document({
    creator: input.author ?? "Flaw",
    title: input.title,
    styles: { default: { document: { run: { font: base.font, size: base.sizePt * 2 } } } },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
            { level: 1, format: LevelFormat.BULLET, text: "◦", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
          ],
        },
        {
          reference: "numbers",
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
            { level: 1, format: LevelFormat.LOWER_LETTER, text: "%2.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          titlePage: titlePage.length > 0,
          page: {
            size: { width: twip(size.width), height: twip(size.height) },
            margin: { top: twip(top), right: twip(right), bottom: twip(bottom), left: twip(left), header: twip(top / 2), footer: twip(bottom / 2) },
          },
        },
        headers: input.mode === "novel" ? { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: input.title, smallCaps: true, font: base.font, size: 17 })] })] }) } : undefined,
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: base.font, size: 18 })] })],
          }),
        },
        children: [...titlePage, ...body],
      },
    ],
  });
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}

export { plainText };
