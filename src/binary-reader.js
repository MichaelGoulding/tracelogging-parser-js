/**
 * Binary reader for parsing little-endian binary data from ArrayBuffer/Uint8Array.
 * Replaces Python's `construct` library with manual DataView-based parsing.
 */
class BinaryReader {
  /**
   * @param {ArrayBuffer|Uint8Array} buffer
   * @param {number} [offset=0]
   */
  constructor(buffer, offset = 0) {
    if (buffer instanceof Uint8Array) {
      this._buffer = buffer.buffer;
      this._baseOffset = buffer.byteOffset;
      this._length = buffer.byteLength;
    } else {
      this._buffer = buffer;
      this._baseOffset = 0;
      this._length = buffer.byteLength;
    }
    this._view = new DataView(this._buffer, this._baseOffset, this._length);
    this._offset = offset;
  }

  get offset() {
    return this._offset;
  }

  set offset(v) {
    this._offset = v;
  }

  get length() {
    return this._length;
  }

  get remaining() {
    return this._length - this._offset;
  }

  tell() {
    return this._offset;
  }

  seek(offset) {
    this._offset = offset;
  }

  skip(count) {
    this._offset += count;
  }

  /**
   * Align the current offset to the given boundary.
   * @param {number} alignment
   */
  align(alignment) {
    const remainder = this._offset % alignment;
    if (remainder !== 0) {
      this._offset += alignment - remainder;
    }
  }

  readUint8() {
    const v = this._view.getUint8(this._offset);
    this._offset += 1;
    return v;
  }

  readInt8() {
    const v = this._view.getInt8(this._offset);
    this._offset += 1;
    return v;
  }

  readUint16() {
    const v = this._view.getUint16(this._offset, true);
    this._offset += 2;
    return v;
  }

  readInt16() {
    const v = this._view.getInt16(this._offset, true);
    this._offset += 2;
    return v;
  }

  readUint32() {
    const v = this._view.getUint32(this._offset, true);
    this._offset += 4;
    return v;
  }

  readInt32() {
    const v = this._view.getInt32(this._offset, true);
    this._offset += 4;
    return v;
  }

  readUint64() {
    const lo = this._view.getUint32(this._offset, true);
    const hi = this._view.getUint32(this._offset + 4, true);
    this._offset += 8;
    return BigInt(lo) | (BigInt(hi) << 32n);
  }

  readInt64() {
    const lo = this._view.getUint32(this._offset, true);
    const hi = this._view.getInt32(this._offset + 4, true);
    this._offset += 8;
    return BigInt(lo) | (BigInt(hi) << 32n);
  }

  readFloat32() {
    const v = this._view.getFloat32(this._offset, true);
    this._offset += 4;
    return v;
  }

  readFloat64() {
    const v = this._view.getFloat64(this._offset, true);
    this._offset += 8;
    return v;
  }

  /**
   * Read raw bytes as a Uint8Array (a view into the original buffer).
   * @param {number} count
   * @returns {Uint8Array}
   */
  readBytes(count) {
    const bytes = new Uint8Array(this._buffer, this._baseOffset + this._offset, count);
    this._offset += count;
    return bytes;
  }

  /**
   * Read a copy of raw bytes.
   * @param {number} count
   * @returns {Uint8Array}
   */
  readBytesCopy(count) {
    return new Uint8Array(this.readBytes(count));
  }

  /**
   * Create a sub-reader from the current position for a given length.
   * Advances the parent reader past the sub-region.
   * @param {number} length
   * @returns {BinaryReader}
   */
  subReader(length) {
    const sub = new BinaryReader(
      new Uint8Array(this._buffer, this._baseOffset + this._offset, length)
    );
    this._offset += length;
    return sub;
  }

  /**
   * Read a null-terminated ASCII string.
   * @returns {string}
   */
  readCString() {
    const start = this._offset;
    while (this._offset < this._length && this._view.getUint8(this._offset) !== 0) {
      this._offset++;
    }
    const bytes = new Uint8Array(this._buffer, this._baseOffset + start, this._offset - start);
    this._offset++; // skip null terminator
    return new TextDecoder('ascii').decode(bytes);
  }

  /**
   * Read a null-terminated UTF-16LE string.
   * @returns {string}
   */
  readWString() {
    const start = this._offset;
    while (this._offset + 1 < this._length) {
      const lo = this._view.getUint8(this._offset);
      const hi = this._view.getUint8(this._offset + 1);
      this._offset += 2;
      if (lo === 0 && hi === 0) break;
    }
    const bytes = new Uint8Array(this._buffer, this._baseOffset + start, this._offset - start - 2);
    return new TextDecoder('utf-16le').decode(bytes);
  }

  /**
   * Read a GUID (16 bytes) and return as a formatted string.
   * @returns {string}
   */
  readGuid() {
    const data1 = this.readUint32();
    const data2 = this.readUint16();
    const data3 = this.readUint16();
    const data4 = this.readBytesCopy(8);

    const hex = (v, len) => v.toString(16).padStart(len, '0');
    const d4Hex = Array.from(data4).map(b => hex(b, 2)).join('');

    return `${hex(data1, 8)}-${hex(data2, 4)}-${hex(data3, 4)}-${d4Hex.slice(0, 4)}-${d4Hex.slice(4)}`;
  }

  /**
   * Read a Windows SYSTEMTIME structure (16 bytes).
   */
  readSystemTime() {
    return {
      year: this.readInt16(),
      month: this.readInt16(),
      dayOfWeek: this.readInt16(),
      day: this.readInt16(),
      hour: this.readInt16(),
      minute: this.readInt16(),
      second: this.readInt16(),
      milliseconds: this.readInt16(),
    };
  }
}

module.exports = { BinaryReader };
