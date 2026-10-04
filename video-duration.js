/*
 * Reads a video's length (seconds) straight from the file, without ffmpeg:
 *   MP4 / MOV / 3GP : the "mvhd" box (timescale + duration)
 *   WebM / MKV      : the Segment Info "Duration" element (x TimecodeScale)
 * Returns null when it can't be read; the caller then allows the upload
 * (the app checks the length on the phone too).
 */
function mp4Duration(buf) {
  let i = buf.indexOf('mvhd');
  while (i >= 4) {
    try {
      const v = buf.readUInt8(i + 4);
      let timescale, duration;
      if (v === 1) { timescale = buf.readUInt32BE(i + 24); duration = Number(buf.readBigUInt64BE(i + 28)); }
      else { timescale = buf.readUInt32BE(i + 16); duration = buf.readUInt32BE(i + 20); }
      if (timescale > 0 && duration > 0 && duration !== 0xffffffff) return duration / timescale;
    } catch {}
    i = buf.indexOf('mvhd', i + 4);
  }
  return null;
}

function webmDuration(buf) {
  if (buf.length < 4 || buf.readUInt32BE(0) !== 0x1a45dfa3) return null;   // EBML header
  const area = buf.subarray(0, Math.min(buf.length, 1 << 20));
  let scale = 1000000;                                                     // ns per tick (default)
  const ts = area.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]));
  if (ts >= 0) {
    const sz = area[ts + 3];
    if (sz >= 0x81 && sz <= 0x88) { let v = 0; for (let k = 0; k < sz - 0x80; k++) v = v * 256 + area[ts + 4 + k]; if (v > 0) scale = v; }
  }
  let d = area.indexOf(Buffer.from([0x44, 0x89]));
  while (d >= 0) {
    const sz = area[d + 2];
    try {
      if (sz === 0x84) return (area.readFloatBE(d + 3) * scale) / 1e9;
      if (sz === 0x88) return (area.readDoubleBE(d + 3) * scale) / 1e9;
    } catch {}
    d = area.indexOf(Buffer.from([0x44, 0x89]), d + 2);
  }
  return null;
}

function videoDurationSeconds(buf, mime = '') {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  const isWebm = /webm|matroska|mkv/i.test(mime) || buf.readUInt32BE(0) === 0x1a45dfa3;
  const d = isWebm ? webmDuration(buf) : mp4Duration(buf);
  return Number.isFinite(d) && d > 0 && d < 24 * 3600 ? d : null;
}

module.exports = { videoDurationSeconds, MAX_VIDEO_SECONDS: 180 };
