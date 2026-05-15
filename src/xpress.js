/**
 * XPRESS (Plain LZ77) decompression for compressed ETW buffers.
 *
 * Implements the Microsoft Plain LZ77 decompression algorithm as documented in
 * MS-XCA (XPRESS Compression Algorithm) section 2.3/2.4:
 * https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-xca
 *
 * Used when ETW_BUFFER_FLAG_COMPRESSED (0x40) is set on an ETL buffer.
 * ETW uses COMPRESSION_FORMAT_XPRESS (plain LZ77, not Huffman).
 *
 * Match length encoding uses a nibble-sharing scheme: when the initial 3-bit
 * length field is 7 (maximum), extended length is read as a 4-bit nibble.
 * Consecutive extended matches alternate between the low and high nibbles of
 * a shared byte, reducing overhead.
 */

/**
 * Decompress XPRESS (Plain LZ77) compressed data.
 *
 * @param {Uint8Array} input - Compressed data
 * @param {number} uncompressedSize - Expected uncompressed size
 * @returns {Uint8Array} Decompressed data
 */
function decompressXpress(input, uncompressedSize) {
  const output = new Uint8Array(uncompressedSize);
  let inPos = 0;
  let outPos = 0;
  let nibbleIndex = 0;

  while (inPos < input.length && outPos < uncompressedSize) {
    // Read 4-byte flag word
    if (inPos + 4 > input.length) break;
    const flags = (input[inPos] | (input[inPos + 1] << 8) |
                   (input[inPos + 2] << 16) | (input[inPos + 3] << 24)) >>> 0;
    inPos += 4;

    if (inPos >= input.length) break;

    // Process 32 items, checking bits from MSB (bit 31) down to LSB (bit 0)
    for (let bitIdx = 31; bitIdx >= 0 && outPos < uncompressedSize; bitIdx--) {
      if (inPos >= input.length) break;

      if (((flags >>> bitIdx) & 1) === 0) {
        // Literal byte
        output[outPos++] = input[inPos++];
      } else {
        // Match reference: read 2-byte metadata
        if (inPos + 2 > input.length) break;
        const matchVal = input[inPos] | (input[inPos + 1] << 8);
        inPos += 2;

        const matchOffset = (matchVal >>> 3) + 1;
        let matchLength = matchVal & 7;

        if (matchLength === 7) {
          // Extended length via nibble-sharing scheme
          let nibbleLen;
          if (nibbleIndex === 0) {
            if (inPos >= input.length) break;
            nibbleIndex = inPos;
            nibbleLen = input[inPos] & 0xf;
            inPos++;
          } else {
            nibbleLen = input[nibbleIndex] >> 4;
            nibbleIndex = 0;
          }
          matchLength = nibbleLen;

          if (matchLength === 15) {
            // Further extended: read full byte
            if (inPos >= input.length) break;
            matchLength = input[inPos++];
            if (matchLength === 255) {
              // Even further: read 16-bit or 32-bit length
              if (inPos + 2 > input.length) break;
              matchLength = input[inPos] | (input[inPos + 1] << 8);
              inPos += 2;
              if (matchLength === 0) {
                if (inPos + 4 > input.length) break;
                matchLength = (input[inPos] | (input[inPos + 1] << 8) |
                               (input[inPos + 2] << 16) | (input[inPos + 3] << 24)) >>> 0;
                inPos += 4;
              }
              if (matchLength < 15 + 7) break;
              matchLength -= (15 + 7);
            }
            matchLength += 15;
          }
          matchLength += 7;
        }

        matchLength += 3;

        // Copy match bytes (byte-by-byte for overlapping matches)
        const srcStart = outPos - matchOffset;
        if (srcStart < 0) break;
        for (let i = 0; i < matchLength && outPos < uncompressedSize; i++) {
          output[outPos] = output[srcStart + i];
          outPos++;
        }
      }
    }
  }

  return outPos === uncompressedSize ? output : output.slice(0, outPos);
}

module.exports = { decompressXpress };
