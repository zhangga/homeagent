import { describe, expect, test } from "bun:test";
import { zipFixture } from "../../../test-support/zip.ts";
import { extractMaterialText, MAX_MATERIAL_BYTES, splitMaterialText } from "./material-text.ts";

describe("full material text extraction", () => {
  test("keeps long standalone text, JSONL, and all Unicode segments", () => {
    const original = `${"甲".repeat(199_999)}😀\n${"乙".repeat(200_000)}TAIL_MARKER`;
    const text = extractMaterialText("消息.JSONL", new TextEncoder().encode(original))!;
    const parts = splitMaterialText(text);
    expect(parts).toHaveLength(3);
    expect(parts.join("")).toBe(original);
    expect(parts.every(part => part.length <= 200_000 && part.isWellFormed())).toBeTrue();
  });

  test("reads Word paragraphs, tables, entities, headers, and footnotes beyond 200k", () => {
    const bytes = zipFixture([
      { name: "word/document.xml", content: `<w:document><w:body><w:p><w:r><w:t>${"甲".repeat(200_001)}</w:t><w:tab/><w:t>A &amp; B</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格末尾</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>` },
      { name: "word/header1.xml", content: "<w:hdr><w:p><w:r><w:t>页眉</w:t></w:r></w:p></w:hdr>" },
      { name: "word/footnotes.xml", content: "<w:footnotes><w:footnote><w:p><w:r><w:t>脚注证据</w:t></w:r></w:p></w:footnote></w:footnotes>" },
    ]);
    const text = extractMaterialText("report.docx", bytes)!;
    expect(text).toContain(`${"甲".repeat(200_001)}\tA & B`);
    expect(text).toContain("表格末尾");
    expect(text).toContain("页眉");
    expect(text).toContain("脚注证据");
    expect(splitMaterialText(text).join("")).toBe(text);
  });

  test("reads Excel sheets in workbook order with shared/inline strings and cached formula values", () => {
    const bytes = zipFixture([
      { name: "xl/workbook.xml", content: '<workbook><sheets><sheet name="第二表 &amp; 汇总" r:id="r2"/><sheet name="第一表" r:id="r1"/></sheets></workbook>' },
      { name: "xl/_rels/workbook.xml.rels", content: '<Relationships><Relationship Id="r1" Target="worksheets/sheet9.xml"/><Relationship Id="r2" Target="/xl/worksheets/sheet2.xml"/></Relationships>' },
      { name: "xl/sharedStrings.xml", content: '<sst><si><r><t>发布</t></r><r><t>负责人</t></r><rPh><t>fayin</t></rPh></si></sst>' },
      { name: "xl/worksheets/sheet2.xml", content: '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>小王</t></is></c><c r="C1"><f>SUM(A2:A3)</f><v>42</v></c><c r="D1" t="b"><v>1</v></c><c r="E1"><f>A2+1</f></c></row></sheetData></worksheet>' },
      { name: "xl/worksheets/sheet9.xml", content: '<worksheet><sheetData><row><c r="A1"><v>123</v></c></row></sheetData></worksheet>' },
    ]);
    const text = extractMaterialText("report.xlsx", bytes)!;
    expect(text).toContain("工作表：第二表 & 汇总");
    expect(text.indexOf("第二表")).toBeLessThan(text.indexOf("第一表"));
    expect(text).toContain("A1\t发布负责人");
    expect(text).not.toContain("fayin");
    expect(text).toContain("B1\t小王");
    expect(text).toContain("42 [公式：=SUM(A2:A3)；值为文件保存时的缓存]");
    expect(text).toContain("D1\ttrue");
    expect(text).toContain("未计算");
    expect(text).toContain("A1\t123");
  });

  test("reads PowerPoint slides in presentation order instead of filename order", () => {
    const bytes = zipFixture([
      { name: "ppt/presentation.xml", content: '<p:presentation><p:sldIdLst><p:sldId r:id="r9"/><p:sldId r:id="r2"/></p:sldIdLst></p:presentation>' },
      { name: "ppt/_rels/presentation.xml.rels", content: '<Relationships><Relationship Id="r2" Target="slides/slide2.xml"/><Relationship Id="r9" Target="slides/slide9.xml"/></Relationships>' },
      { name: "ppt/slides/slide2.xml", content: '<p:sld><a:p><a:r><a:t>最终结论</a:t></a:r></a:p></p:sld>' },
      { name: "ppt/slides/slide9.xml", content: '<p:sld><a:p><a:r><a:t>背景 &lt;说明&gt;</a:t></a:r></a:p></p:sld>' },
    ]);
    expect(extractMaterialText("deck.pptx", bytes)).toBe("## 幻灯片 1\n背景 <说明>\n\n## 幻灯片 2\n最终结论");
  });

  test("rejects damaged Office XML or missing parts instead of returning a partial success", () => {
    expect(() => extractMaterialText("bad.docx", zipFixture([{ name: "word/document.xml", content: "<w:document><w:t>partial</broken>" }]))).toThrow();
    expect(() => extractMaterialText("bad.docx", zipFixture([]))).toThrow();
    expect(extractMaterialText("photo.bin", new Uint8Array([0xff]))).toBeNull();
    expect(() => extractMaterialText("bad.txt", new Uint8Array([0xff]))).toThrow();
  });

  test("preserves the existing file size boundary without shortening valid input", () => {
    const bytes = new Uint8Array(MAX_MATERIAL_BYTES).fill(65);
    expect(extractMaterialText("max.txt", bytes)?.length).toBe(MAX_MATERIAL_BYTES);
    expect(() => extractMaterialText("over.txt", new Uint8Array(MAX_MATERIAL_BYTES + 1))).toThrow("20 MiB");
  });
});
