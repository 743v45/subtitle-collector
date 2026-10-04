// 零依赖 zip 打包（node 内置 zlib.deflateRawSync + 手写容器格式）——export bundle 的 web 下载通道用。
// 容器布局：每个文件 [本地文件头(30B)+文件名+deflate 原始流] + [中央目录条目(46B)+文件名]* + EOCD(22B)。
// 约束：version needed 20、method=8（deflate）、UTF-8 文件名 flag（bit 11）置位（videos/<标题>.txt 有中文）、
// 无 zip64（文件数/大小远达不到）；总 uncompressed ≥ 4GB 时防御性报错（HttpError 413）而非产出坏包。
// 措辞：字幕（subtitle），非弹幕。
import { deflateRawSync } from 'node:zlib';
import { HttpError } from './http-util.js';

export interface ZipInputFile {
  name: string;    // zip 内路径（相对根，如 manifest.json / videos/xxx.txt）
  content: string; // 统一 UTF-8 文本
}

export interface CreateZipOpts {
  mtime?: Date; // 条目修改时间（DOS 时间，秒精度）；缺省 now
}

// zip 4GB 上界（无 zip64）：总 uncompressed 字节数断言（打包前，防产出截断坏包）
const MAX_ZIP_BYTES = 4 * 1024 * 1024 * 1024;

// CRC32 查表（多项式 0xEDB88320 反射，标准 zip 口径）；模块加载时建一次 256 项表。
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Date → DOS 时间（time: 时<<11|分<<5|秒/2；date: (年-1980)<<9|月<<5|日）。年 <1980 钳到 1980。
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * files → zip Buffer。防御性报错（调用方 bug 而非用户错误，抛 Error 走 runHandler 500 + 日志）：
 * - files 空数组：拒绝打空包（bundle 恒有 manifest.json + ANALYZE.md，空列表必是上游逻辑错误）
 * - 文件名重复：zip 无覆盖语义，重名产出歧义包直接拒
 * - 总大小 ≥ 4GB：无 zip64 支持的硬上界（用户可感知的超大数据集 → HttpError 413）
 */
export function createZip(files: ZipInputFile[], opts: CreateZipOpts = {}): Buffer {
  if (files.length === 0) throw new Error('createZip: files 为空，拒绝打空包');
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.name)) throw new Error(`createZip: 文件名重复: ${f.name}`);
    seen.add(f.name);
  }
  const totalUncompressed = files.reduce((s, f) => s + Buffer.byteLength(f.content, 'utf8'), 0);
  if (totalUncompressed >= MAX_ZIP_BYTES) {
    throw new HttpError(413, `zip 总大小超限: ${totalUncompressed} >= ${MAX_ZIP_BYTES} 字节（未实现 zip64）`);
  }

  const { time, date } = dosDateTime(opts.mtime ?? new Date());
  const chunks: Buffer[] = [];   // 本地头 + 压缩数据（按文件顺序）
  const central: Buffer[] = [];  // 中央目录条目
  let offset = 0;                // 当前本地头偏移（中央目录条目的 local header offset 字段）
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.content, 'utf8');
    const def = deflateRawSync(raw);
    const crc = crc32(raw);

    // 本地文件头 30B + 文件名
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);  // signature PK\x03\x04
    local.writeUInt16LE(20, 4);          // version needed = 2.0
    local.writeUInt16LE(0x0800, 6);      // general purpose flags：bit 11 = UTF-8 文件名
    local.writeUInt16LE(8, 8);           // compression method = deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(def.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    // extra field length (28) 已由 alloc 清零
    nameBuf.copy(local, 30);
    chunks.push(local, def);

    // 中央目录条目 46B + 文件名（extra/comment len、disk start、internal/external attrs 全零由 alloc 覆盖）
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);     // signature PK\x01\x02
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0x0800, 8);         // flags：bit 11 UTF-8
    cd.writeUInt16LE(8, 10);             // method
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(def.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);        // local header 相对偏移
    nameBuf.copy(cd, 46);
    central.push(cd);

    offset += local.length + def.length;
  }

  const centralBuf = Buffer.concat(central);
  // EOCD 22B（comment len 等全零由 alloc 覆盖）
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);     // signature PK\x05\x06
  eocd.writeUInt16LE(files.length, 8);   // 本盘条目数
  eocd.writeUInt16LE(files.length, 10);  // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);        // 中央目录起始偏移
  return Buffer.concat([...chunks, centralBuf, eocd]);
}
