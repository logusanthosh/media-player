function syncSafeInteger(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

function frameSize(bytes, offset, version) {
  if (version === 2) return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
  if (version === 4) return syncSafeInteger(bytes, offset);
  return (bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function decodeText(data) {
  if (!data.length) return '';
  const encodings = ['windows-1252', 'utf-16', 'utf-16be', 'utf-8'];
  const encoding = encodings[data[0]] ?? 'utf-8';
  return new TextDecoder(encoding).decode(data.subarray(1)).replace(/\0/g, '').trim();
}

function readPicture(data, version) {
  if (data.length < 5) return null;
  const encoding = data[0];
  let cursor = 1;
  let mime;
  if (version === 2) {
    const format = String.fromCharCode(...data.subarray(cursor, cursor + 3)).toUpperCase();
    mime = format === 'PNG' ? 'image/png' : 'image/jpeg';
    cursor += 3;
  } else {
    const mimeEnd = data.indexOf(0, cursor);
    if (mimeEnd < 0) return null;
    mime = new TextDecoder('ascii').decode(data.subarray(cursor, mimeEnd));
    cursor = mimeEnd + 1;
  }
  cursor += 1;
  if (encoding === 0 || encoding === 3) {
    const descriptionEnd = data.indexOf(0, cursor);
    if (descriptionEnd < 0) return null;
    cursor = descriptionEnd + 1;
  } else {
    while (cursor + 1 < data.length && (data[cursor] !== 0 || data[cursor + 1] !== 0)) cursor += 2;
    cursor += 2;
  }
  if (cursor >= data.length || !mime.startsWith('image/')) return null;
  return new Blob([data.subarray(cursor)], { type: mime });
}

export async function readEmbeddedMetadata(file) {
  const header = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (header.length < 10 || header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) return {};
  const version = header[3];
  if (version < 2 || version > 4) return {};
  const tagLength = syncSafeInteger(header, 6);
  if (tagLength <= 0 || tagLength > 32 * 1024 * 1024) return {};
  const frames = new Uint8Array(await file.slice(10, 10 + tagLength).arrayBuffer());
  const metadata = {};
  let offset = header[5] & 0x40 ? 4 + frameSize(frames, 0, version) : 0;
  const frameHeaderLength = version === 2 ? 6 : 10;

  while (offset + frameHeaderLength <= frames.length) {
    const idLength = version === 2 ? 3 : 4;
    const frameId = String.fromCharCode(...frames.subarray(offset, offset + idLength));
    if (!/^[A-Z0-9]{3,4}$/.test(frameId)) break;
    const size = frameSize(frames, offset + idLength, version);
    if (!size || offset + frameHeaderLength + size > frames.length) break;
    const contentOffset = offset + frameHeaderLength;
    const content = frames.subarray(contentOffset, contentOffset + size);
    const textFrame = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album' }[frameId];
    if (textFrame && !metadata[textFrame]) metadata[textFrame] = decodeText(content);
    if ((frameId === 'APIC' || frameId === 'PIC') && !metadata.artwork) {
      metadata.artwork = readPicture(content, version);
    }
    offset = contentOffset + size;
  }

  if (metadata.artwork) metadata.artworkUrl = URL.createObjectURL(metadata.artwork);
  return metadata;
}
