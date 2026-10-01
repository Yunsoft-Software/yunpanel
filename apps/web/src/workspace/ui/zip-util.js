// Pure JavaScript ZIP archive creator and extractor.
// Implements PKZIP 2.0 specification without external dependencies.
// Supports STORE (method 0) and DEFLATE (method 8) decompression via Web DecompressionStream or zlib.

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const d = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: d };
}

/**
 * Packs entries into a standard ZIP archive (Uint8Array).
 * @param {Array<{path: string, data?: Uint8Array, isDir?: boolean}>} entries
 * @returns {Uint8Array}
 */
export function packZip(entries) {
  const encoder = new TextEncoder();
  const { time: dosTime, date: dosDate } = dosDateTime();
  const localHeaders = [];
  const centralRecords = [];
  let offset = 0;

  for (const entry of entries) {
    let entryPath = entry.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const isDir = Boolean(entry.isDir || entryPath.endsWith('/'));
    if (isDir && !entryPath.endsWith('/')) {
      entryPath += '/';
    }
    const nameBytes = encoder.encode(entryPath);
    const data = isDir ? new Uint8Array(0) : (entry.data ? (entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data)) : new Uint8Array(0));
    const dataCrc = isDir ? 0 : crc32(data);
    const size = data.length;

    // Local file header (30 bytes + nameBytes.length + data.length)
    const localHeader = new Uint8Array(30 + nameBytes.length + size);
    const lv = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength);

    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, dataCrc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    localHeader.set(data, 30 + nameBytes.length);

    localHeaders.push(localHeader);

    // Central directory header (46 bytes + nameBytes.length)
    const cdRecord = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdRecord.buffer, cdRecord.byteOffset, cdRecord.byteLength);

    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, dataCrc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, isDir ? 0x10 : 0, true);
    cv.setUint32(42, offset, true);
    cdRecord.set(nameBytes, 46);

    centralRecords.push(cdRecord);
    offset += localHeader.length;
  }

  const cdOffset = offset;
  const cdSize = centralRecords.reduce((sum, r) => sum + r.length, 0);

  // End of Central Directory Record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);

  const totalLength = cdOffset + cdSize + 22;
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const lh of localHeaders) {
    result.set(lh, pos);
    pos += lh.length;
  }
  for (const cd of centralRecords) {
    result.set(cd, pos);
    pos += cd.length;
  }
  result.set(eocd, pos);

  return result;
}

/**
 * Inflates raw DEFLATE bytes using DecompressionStream or node:zlib
 */
async function inflateRawBytes(compressedBytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(compressedBytes);
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const len = chunks.reduce((acc, c) => acc + c.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  const zlib = await import('node:zlib');
  return new Uint8Array(zlib.inflateRawSync(compressedBytes));
}

const MAX_UNPACK_FILE_BYTES = 16 * 1024 * 1024;
const MAX_UNPACK_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Unpacks entries from a ZIP archive.
 * Validates path traversal and zip-bomb limits.
 * @param {Uint8Array|ArrayBuffer} buffer
 * @returns {Promise<Array<{path: string, data: Uint8Array, isDir: boolean}>>}
 */
export async function unpackZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');

  let eocdOffset = -1;
  const minScan = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minScan; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Geçersiz ZIP arşivi: EOCD başlığı bulunamadı.');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  if (cdOffset >= bytes.length) {
    throw new Error('Geçersiz ZIP arşivi: Dizin başlangıcı dosya sınırlarının dışında.');
  }

  let cdPos = cdOffset;
  const entries = [];
  let totalBytesExtracted = 0;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (cdPos + 46 > bytes.length) break;
    const cdSig = view.getUint32(cdPos, true);
    if (cdSig !== 0x02014b50) break;

    const method = view.getUint16(cdPos + 10, true);
    const compressedSize = view.getUint32(cdPos + 20, true);
    const uncompressedSize = view.getUint32(cdPos + 24, true);
    const nameLen = view.getUint16(cdPos + 28, true);
    const extraLen = view.getUint16(cdPos + 30, true);
    const commentLen = view.getUint16(cdPos + 32, true);
    const localOffset = view.getUint32(cdPos + 42, true);

    const nameBytes = bytes.subarray(cdPos + 46, cdPos + 46 + nameLen);
    const rawPath = decoder.decode(nameBytes).replace(/\\/g, '/');

    cdPos += 46 + nameLen + extraLen + commentLen;

    // Security check 1: Path traversal protection
    const normalized = rawPath.replace(/^\/+/, '');
    if (normalized.includes('..') || normalized.startsWith('/') || /[\u0000-\u001f\u007f]/.test(normalized)) {
      throw new Error(`Güvenlik ihlali: Arşiv dosya yolu geçersiz veya tehlikeli (${rawPath}).`);
    }

    const isDir = normalized.endsWith('/');
    const cleanPath = isDir ? normalized.slice(0, -1) : normalized;
    if (!cleanPath) continue;

    // Security check 2: Zip-bomb size limit protection
    if (uncompressedSize > MAX_UNPACK_FILE_BYTES) {
      throw new Error(`Arşivdeki dosya boyutu sınırı aşıyor (${cleanPath}: ${uncompressedSize} bayt, sınır: ${MAX_UNPACK_FILE_BYTES} bayt).`);
    }
    totalBytesExtracted += uncompressedSize;
    if (totalBytesExtracted > MAX_UNPACK_TOTAL_BYTES) {
      throw new Error(`Arşiv toplam açılan dosya boyutu sınırını aşıyor (maksimum ${MAX_UNPACK_TOTAL_BYTES} bayt).`);
    }

    if (isDir) {
      entries.push({ path: cleanPath, data: new Uint8Array(0), isDir: true });
      continue;
    }

    // Read from local header
    if (localOffset + 30 > bytes.length) {
      throw new Error(`Geçersiz yerel başlık: ${cleanPath}`);
    }
    const localSig = view.getUint32(localOffset, true);
    if (localSig !== 0x04034b50) {
      throw new Error(`Geçersiz yerel başlık imzası: ${cleanPath}`);
    }

    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;

    if (dataStart + compressedSize > bytes.length) {
      throw new Error(`Dosya verisi arşiv sınırlarının dışında: ${cleanPath}`);
    }

    const rawData = bytes.subarray(dataStart, dataStart + compressedSize);
    let extractedData;
    if (method === 0) {
      extractedData = rawData;
    } else if (method === 8) {
      extractedData = await inflateRawBytes(rawData);
    } else {
      throw new Error(`Desteklenmeyen sıkıştırma yöntemi (${method}) dosya için: ${cleanPath}`);
    }

    entries.push({ path: cleanPath, data: extractedData, isDir: false });
  }

  return entries;
}
