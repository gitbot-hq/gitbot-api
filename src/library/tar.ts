/**
 * Minimal ustar/pax reader, enough for a GitHub tarball: regular files only,
 * long names via the ustar prefix field or a pax `path` record.
 */
export type TarEntry = { path: string; data: Buffer };

const BLOCK = 512;

function str(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString("utf8");
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const len = parseInt(data.subarray(pos, space).toString("ascii"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.subarray(space + 1, pos + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

export function* readTar(buf: Buffer): Generator<TarEntry> {
  let pos = 0;
  let paxPath: string | undefined;
  let longName: string | undefined;
  while (pos + BLOCK <= buf.length) {
    const header = buf.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const size = parseInt(str(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156]) || "0";
    const magic = str(header, 257, 6);
    let name = str(header, 0, 100);
    const prefix = magic.startsWith("ustar") ? str(header, 345, 155) : "";
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = pos + BLOCK;
    const data = buf.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") { paxPath = parsePax(data).path; continue; }
    if (type === "L") { longName = data.toString("utf8").replace(/\0+$/, ""); continue; }
    const path = paxPath ?? longName ?? name;
    paxPath = undefined;
    longName = undefined;
    if (type === "0" || type === "\0") yield { path, data: Buffer.from(data) };
  }
}
