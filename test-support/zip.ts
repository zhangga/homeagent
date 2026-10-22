import { crc32, deflateRawSync } from "node:zlib";

interface ZipFixtureEntry {
  name: string;
  content: string | Uint8Array;
  stored?: boolean;
  flags?: number;
  attributes?: number;
  declaredSize?: number;
  checksum?: number;
  method?: number;
  encodedName?: Uint8Array;
}

/** Small ZIP fixture writer independent of the production reader. */
export function zipFixture(entries: ZipFixtureEntry[], comment = ""): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.encodedName ?? Buffer.from(entry.name));
    const content = Buffer.from(entry.content);
    const compressed = entry.stored ? content : deflateRawSync(content);
    const method = entry.method ?? (entry.stored ? 0 : 8);
    const flags = entry.flags ?? 0x800;
    const checksum = entry.checksum ?? crc32(content);
    const size = entry.declaredSize ?? content.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.attributes ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    directory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const footer = Buffer.alloc(22);
  const commentBytes = Buffer.from(comment);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(entries.length, 8);
  footer.writeUInt16LE(entries.length, 10);
  footer.writeUInt32LE(directoryBytes.length, 12);
  footer.writeUInt32LE(offset, 16);
  footer.writeUInt16LE(commentBytes.length, 20);
  return new Uint8Array(Buffer.concat([...locals, directoryBytes, footer, commentBytes]));
}
