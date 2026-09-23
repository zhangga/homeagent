import { describe, expect, test } from "bun:test";
import { localMaterialRawContent, prepareLocalMaterials } from "./local-materials.ts";
import { zipFixture } from "./local-materials.fixture.ts";

function uploadZip(entries: Parameters<typeof zipFixture>[0], name = "资料.ZIP") {
  return new File([zipFixture(entries, "中文备注")], name);
}

describe("ZIP local materials", () => {
  test("extracts stored and deflated text in nested directories with member provenance", async () => {
    const zip = uploadZip([
      { name: "目录/", content: "", stored: true },
      { name: "目录/说明.md", content: "发布前进行复核", stored: true },
      { name: "历史/记录.jsonl", content: '{"正文":"故障由小王处理"}\n' },
      { name: "历史/更多.ndjson", content: '{"正文":"恢复服务"}' },
      { name: "image.png", content: new Uint8Array([0xff, 0x00]) },
    ]);
    const materials = await prepareLocalMaterials(zip);
    expect(materials).toHaveLength(4);
    expect(materials[0]?.bytes).toEqual(new Uint8Array(await zip.arrayBuffer()));
    expect(materials[0]?.content).toContain("3 个文本文件");
    expect(materials[0]?.content).toContain("1 个文件未提取正文");
    expect(materials[1]?.content).toBe("发布前进行复核");
    expect(localMaterialRawContent(materials[2]!)).toContain("包内路径：历史/记录.jsonl");
    expect(localMaterialRawContent(materials[2]!)).toContain("来源压缩包：资料.ZIP");
    expect(materials[3]?.content).toContain("恢复服务");
  });

  test("processes more than 20 members without applying the upload count to members", async () => {
    const entries = Array.from({ length: 45 }, (_, i) => ({ name: `${i}.txt`, content: `资料 ${i}` }));
    const materials = await prepareLocalMaterials(uploadZip(entries));
    expect(materials).toHaveLength(46);
    expect(materials.at(-1)?.content).toBe("资料 44");
  });

  test("splits long members without dropping the tail or breaking surrogate pairs", async () => {
    const original = `${"甲".repeat(199_999)}😀\n${"乙".repeat(200_000)}TAIL_MARKER`;
    const materials = await prepareLocalMaterials(uploadZip([{ name: "long.jsonl", content: original }]));
    const parts = materials.slice(1);
    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.content).join("")).toBe(original);
    for (const [index, part] of parts.entries()) {
      expect(part.content!.length).toBeLessThanOrEqual(200_000);
      expect(part.content!.isWellFormed()).toBeTrue();
      expect(part.bytes).toEqual(new TextEncoder().encode(original));
      expect(part.truncated).toBeFalse();
      expect(part.archive).toEqual({ name: "资料.ZIP", path: "long.jsonl", part: index + 1, parts: 3 });
    }
  });

  test("reads legacy GBK Chinese member names and Windows separators", async () => {
    const materials = await prepareLocalMaterials(uploadZip([{
      name: "中文.txt", encodedName: new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 46, 116, 120, 116]),
      content: "兼容中文文件名", flags: 0,
    }, { name: "目录\\note.md", content: "子目录" }]));
    expect(materials[1]?.name).toBe("中文.txt");
    expect(materials[2]?.archive?.path).toBe("目录/note.md");
  });

  test("retains malformed ZIP originals with an explicit extraction result", async () => {
    for (const original of [new Uint8Array(), new Uint8Array([0x50, 0x4b, 3, 4]), zipFixture([]).slice(0, -1)]) {
      const materials = await prepareLocalMaterials(new File([original], "broken.zip"));
      expect(materials).toHaveLength(1);
      expect(materials[0]?.bytes).toEqual(original);
      expect(materials[0]?.content).toContain("未提取内部正文");
    }
    expect((await prepareLocalMaterials(uploadZip([])))[0]?.content).toContain("0 个文本文件");
  });

  test.each([
    { name: "../escape.txt", content: "escape", reason: "路径无效" },
    { name: "/absolute.txt", content: "escape", reason: "路径无效" },
    { name: "C:\\outside.txt", content: "escape", reason: "路径无效" },
    { name: "link.txt", content: "outside", attributes: 0xa1ff0000, reason: "符号链接" },
    { name: "encrypted.txt", content: "private", flags: 0x801, reason: "已加密" },
    { name: "bad-crc.txt", content: "corrupt", checksum: 0, reason: "校验失败" },
    { name: "method.txt", content: "method", method: 99, reason: "压缩方式不受支持" },
    { name: "large.txt", content: "small", declaredSize: 20 * 1024 * 1024 + 1, reason: "超过 20 MiB" },
    { name: "false-size.txt", content: "larger than declared", declaredSize: 1, reason: "失败" },
    { name: "invalid.txt", content: new Uint8Array([0xff]), reason: "不是 UTF-8" },
    { name: "empty.txt", content: " \n", reason: "正文为空" },
  ])("reports unreadable $name while continuing valid members", async ({ reason, ...entry }) => {
    const materials = await prepareLocalMaterials(uploadZip([
      entry, { name: "valid.md", content: "仍然提炼有效资料" },
    ]));
    expect(materials).toHaveLength(2);
    expect(materials[0]?.content).toContain(reason);
    expect(materials[1]?.content).toBe("仍然提炼有效资料");
  });

  test("retains unsupported and nested members in the original ZIP", async () => {
    const materials = await prepareLocalMaterials(uploadZip([
      { name: "nested.zip", content: zipFixture([{ name: "inner.txt", content: "inner" }]) },
      { name: "report.pdf", content: "%PDF" },
    ]));
    expect(materials).toHaveLength(1);
    expect(materials[0]?.content).toContain("2 个文件未提取正文");
    expect(materials[0]?.content).toContain("nested.zip");
  });

  test("keeps normal text imports unchanged and recognizes standalone JSONL", async () => {
    const materials = await prepareLocalMaterials([
      new File(["甲".repeat(200_001)], "normal.md"),
      new File(['{"content":"消息"}'], "messages.jsonl"),
    ]);
    expect(materials[0]?.truncated).toBeTrue();
    expect(materials[0]?.content).toHaveLength(200_000);
    expect(materials[1]?.content).toContain("消息");
    expect(materials[1]?.archive).toBeUndefined();
  });

  test("accepts a text member exactly at the existing 20 MiB source boundary", async () => {
    const original = "x".repeat(20 * 1024 * 1024);
    const materials = await prepareLocalMaterials(uploadZip([{ name: "boundary.txt", content: original }]));
    expect(materials[0]?.content).toContain("1 个文本文件");
    expect(materials.slice(1).map((part) => part.content).join("")).toBe(original);
    expect(materials[1]?.bytes.byteLength).toBe(20 * 1024 * 1024);
  });

  test("bounds total expanded bytes across uploads using the existing 400 MiB request budget", async () => {
    const content = new Uint8Array(20 * 1024 * 1024).fill(0xff);
    const first = uploadZip(Array.from({ length: 20 }, (_, i) => ({ name: `${i}.txt`, content })));
    const second = uploadZip([{ name: "over.txt", content: "over budget" }]);
    const materials = await prepareLocalMaterials([first, second]);
    expect(materials).toHaveLength(2);
    expect(materials[0]?.content).toContain("20 个文件未提取正文");
    expect(materials[1]?.content).toContain("400 MiB");
  });
});
