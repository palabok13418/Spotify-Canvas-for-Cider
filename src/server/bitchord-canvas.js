import { getAuth } from './bitchord-auth.js';

const CANVAS_URL = 'https://spclient.wg.spotify.com/canvaz-cache/v0/canvases';
const SPOTIFY_APP_UA = 'Spotify/9.0.34.593 iOS/18.4 (iPhone15,3)';
const PREFIX = '[Spotify Canvas Server]';
function log(...args) { console.log(PREFIX, ...args); }
function warn(...args) { console.warn(PREFIX, ...args); }

function writeVarint(value) {
  const out = [];
  let v = BigInt(value);
  while (v >= 0x80n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
  out.push(Number(v));
  return Buffer.from(out);
}
function writeBytes(field, bytes) { return Buffer.concat([writeVarint((field << 3) | 2), writeVarint(bytes.length), bytes]); }
function encodeCanvasRequest(trackUri) {
  const track = writeBytes(1, Buffer.from(trackUri, 'utf8'));
  return writeBytes(1, track);
}
function readVarint(buf, offset) {
  let value = 0n, shift = 0n, i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    value |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [Number(value), i];
    shift += 7n;
    if (shift > 63n) throw new Error('protobuf varint too large');
  }
  throw new Error('unexpected end of protobuf');
}
function readBytes(buf, offset, length) { const end = offset + length; if (end > buf.length) throw new Error('protobuf length overflow'); return [buf.subarray(offset, end), end]; }
function parseCanvasMessage(buf) {
  let offset = 0;
  const canvas = { id: null, canvasUrl: null, trackUri: null };
  while (offset < buf.length) {
    const [tag, afterTag] = readVarint(buf, offset); offset = afterTag;
    const field = tag >>> 3; const wire = tag & 7;
    if (wire === 2) {
      const [length, afterLength] = readVarint(buf, offset); offset = afterLength;
      const [bytes, afterBytes] = readBytes(buf, offset, length); offset = afterBytes;
      if (field === 1 && bytes.length && !(bytes[0] === 0x0a && bytes.length === 1)) return bytes;
      if (field === 2) canvas.canvasUrl = bytes.toString('utf8');
      else if (field === 1) canvas.id = bytes.toString('utf8');
      else if (field === 5) canvas.trackUri = bytes.toString('utf8');
      else if (field === 6) { /* nested artist */ }
    } else if (wire === 0) {
      const [, after] = readVarint(buf, offset); offset = after;
    } else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
  return canvas;
}
function decodeCanvasResponse(buffer) {
  const root = Buffer.from(buffer);
  let offset = 0;
  const canvases = [];
  while (offset < root.length) {
    const [tag, afterTag] = readVarint(root, offset); offset = afterTag;
    const field = tag >>> 3; const wire = tag & 7;
    if (wire !== 2) { if (wire === 0) { const [, after] = readVarint(root, offset); offset = after; } else if (wire === 1) offset += 8; else if (wire === 5) offset += 4; else throw new Error('unsupported root protobuf wire'); continue; }
    const [length, afterLength] = readVarint(root, offset); offset = afterLength;
    const [bytes, afterBytes] = readBytes(root, offset, length); offset = afterBytes;
    if (field === 1) {
      try {
        // Canvas message is itself a length-delimited protobuf message.
        const parsed = parseCanvasMessage(bytes);
        if (parsed && parsed.canvasUrl) canvases.push(parsed);
      } catch {}
    }
  }
  if (!canvases.length) {
    const text = root.toString('latin1');
    const matches = text.match(/https:\/\/[^\s\"']+\.cnvs\.mp4/g) || [];
    return matches.map(url => ({ id: null, canvasUrl: url, trackUri: null }));
  }
  return canvases;
}

export async function getCanvases(spDc, trackUri) {
  const auth = await getAuth(spDc);
  const body = encodeCanvasRequest(trackUri);
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'application/protobuf',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept-Language': 'en',
    'User-Agent': SPOTIFY_APP_UA,
  };
  if (auth.clientToken) headers['Client-Token'] = auth.clientToken;
  const response = await fetch(CANVAS_URL, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = new Error(`Canvas fetch failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const bytes = await response.arrayBuffer();
  const canvases = decodeCanvasResponse(bytes);
  log('BitChord-style Canvas request completed', { trackUri, count: canvases.length, hasClientToken: Boolean(auth.clientToken) });
  return { canvasesList: canvases.map(c => ({ id: c.id, canvasUrl: c.canvasUrl, trackUri: c.trackUri })) };
}
