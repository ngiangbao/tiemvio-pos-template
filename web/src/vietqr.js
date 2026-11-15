/* Reads a bank's VietQR / EMVCo payload and pulls out the receiving account (bank BIN, account number, name). */

const crc16 = str => {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
};

/* The payload is parsed as UTF-8 bytes: EMVCo lengths count bytes, so a name with accents would otherwise break the lengths. */
const toBytesString = text => String.fromCharCode(...new TextEncoder().encode(text));
const fromBytesString = b => { try { return new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0))); } catch (_) { return b; } };

/** Splits "TTLLvalue..." into {tag: value}. Throws when the lengths do not add up. */
function tlv(s) {
  const out = {};
  let i = 0;
  while (i < s.length) {
    if (i + 4 > s.length) throw new Error('bad');
    const tag = s.slice(i, i + 2), len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(tag) || !Number.isInteger(len) || i + 4 + len > s.length) throw new Error('bad');
    out[tag] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

const plain = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
const preview = t => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > 70 ? x.slice(0, 70) + '…' : x; };

/** Returns {bin, account, name} or throws an Error with a message for the owner (Vietnamese). */
export function parseVietQR(text) {
  const raw = toBytesString(String(text || '').trim());
  const shown = preview(text);
  const notBank = 'Mã QR này không phải mã VietQR của ngân hàng (có thể là ví điện tử, link hoặc mã khác).' + (shown ? ' Nội dung đọc được: "' + shown + '"' : '');
  let top;
  try { top = tlv(raw); } catch (_) { throw new Error(notBank); }
  if (!top['38'] && !top['26']) throw new Error(notBank);
  // The merchant-account block is tag 38 for VietQR (some issuers use 26-51); find the one that carries the NAPAS identifier.
  let acct = null;
  for (const tag of Object.keys(top).filter(t => +t >= 26 && +t <= 51)) {
    try { const m = tlv(top[tag]); if (/^A000000727/i.test(m['00'] || '')) { acct = m; break; } } catch (_) { /* try the next block */ }
  }
  if (!acct) throw new Error('Đây không phải mã VietQR chuyển khoản nhanh 24/7 của NAPAS.' + (shown ? ' Nội dung đọc được: "' + shown + '"' : ''));
  let bank;
  try { bank = tlv(acct['01'] || ''); } catch (_) { throw new Error('Không đọc được thông tin tài khoản trong mã QR.'); }
  const bin = String(bank['00'] || '').trim(), account = String(bank['01'] || '').trim();
  if (!/^\d{6}$/.test(bin) || !/^[A-Za-z0-9]{6,30}$/.test(account)) throw new Error('Mã QR không có đủ mã ngân hàng và số tài khoản (đọc được: ' + (bin || '—') + ' / ' + (account || '—') + ').');
  const out = {bin, account, name: plain(fromBytesString(top['59']))};
  if (!/^\d+$/.test(account)) out.alias = true;   // e.g. MB: an identifier like VQRQ0001… stands in for the account number
  // The check code protects against a misread; if it is off but everything else is well-formed, still offer the result and say so.
  const crcAt = raw.lastIndexOf('6304');
  if (!(crcAt >= 0 && raw.slice(crcAt + 4).length === 4 && crc16(raw.slice(0, crcAt + 4)) === raw.slice(crcAt + 4).toUpperCase())) out.crcWarning = true;
  if (/^\d{1,12}$/.test(top['54'] || '') && Number(top['54']) > 0) out.hasAmount = true;
  return out;
}

/** Decodes the QR in an image file (any size, any bank app). Tries the phone's own detector, then jsQR on the whole picture,
 *  a padded copy (tight crops have no quiet zone), higher-contrast copies and sections of the picture. Returns the text. */
export async function readQrFromImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (_) { throw new Error('Không mở được ảnh này. Hãy chọn ảnh PNG hoặc JPG.'); }
  if (typeof BarcodeDetector !== 'undefined') {
    try { const r = await new BarcodeDetector({formats: ['qr_code']}).detect(bmp); if (r && r[0] && r[0].rawValue) return r[0].rawValue; } catch (_) { /* fall through to jsQR */ }
  }
  const {default: jsQR} = await import('jsqr');
  const asText = hit => { try { return hit.binaryData && hit.binaryData.length ? new TextDecoder().decode(Uint8Array.from(hit.binaryData)) : hit.data; } catch (_) { return hit.data; } };
  const draw = (sx, sy, sw, sh, maxSide, pad) => {
    const k = Math.min(1, maxSide / Math.max(sw, sh)), w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k)), p = Math.round(Math.max(w, h) * pad);
    const c = document.createElement('canvas'); c.width = w + p * 2; c.height = h + p * 2;
    const ctx = c.getContext('2d', {willReadFrequently: true}); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, sx, sy, sw, sh, p, p, w, h);
    return ctx.getImageData(0, 0, c.width, c.height);
  };
  const contrast = d => {   // grey, then stretch so a faint or coloured QR becomes black on white
    const px = d.data; let lo = 255, hi = 0; const g = new Uint8Array(px.length / 4);
    for (let i = 0; i < g.length; i++) { const v = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000; g[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const mid = (lo + hi) / 2;
    for (let i = 0; i < g.length; i++) { const v = g[i] < mid ? 0 : 255; px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = 255; }
    return d;
  };
  const W = bmp.width, H = bmp.height, tries = [];
  for (const side of [1200, 800, 1800, 500]) for (const pad of [0, 0.12]) tries.push(() => draw(0, 0, W, H, side, pad));
  for (const pad of [0.12]) tries.push(() => contrast(draw(0, 0, W, H, 1000, pad)));
  // sections: the QR may be a small part of a phone screenshot
  const secs = [[0.1, 0.1, 0.8, 0.8], [0, 0.15, 1, 0.6], [0, 0.3, 1, 0.5], [0.15, 0.25, 0.7, 0.5], [0, 0, 1, 0.6], [0, 0.4, 1, 0.6], [0.25, 0.25, 0.5, 0.5]];
  for (const [fx, fy, fw, fh] of secs) for (const side of [900, 1400]) {
    const sx = Math.round(W * fx), sy = Math.round(H * fy), sw = Math.round(W * fw), sh = Math.round(H * fh);
    tries.push(() => draw(sx, sy, sw, sh, side, 0.12));
    tries.push(() => contrast(draw(sx, sy, sw, sh, side, 0.12)));
  }
  for (const t of tries) {
    const d = t(), hit = jsQR(d.data, d.width, d.height, {inversionAttempts: 'attemptBoth'});
    if (hit && (hit.data || (hit.binaryData && hit.binaryData.length))) { bmp.close && bmp.close(); return asText(hit); }
  }
  bmp.close && bmp.close();
  throw new Error('Không tìm thấy mã QR trong ảnh. Hãy dùng ảnh mã QR rõ nét (ví dụ ảnh "Lưu mã QR" trong app ngân hàng hoặc ảnh chụp màn hình chỉ có mã QR), không bị cắt mất viền.');
}
