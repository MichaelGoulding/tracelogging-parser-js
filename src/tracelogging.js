/**
 * TraceLogging parser.
 * Ported from etl/parsers/tracelogging.py
 *
 * TraceLogging is a self-describing ETW format where metadata (field names, types)
 * is embedded in the extended data of each event (ext_type === 11).
 */
const { BinaryReader } = require('./binary-reader');
const { TraceLoggingMetaDataNotFound, TraceLoggingUnhandledTag } = require('./errors');

/** TraceLogging field type tags (lower 5 bits). */
const TagIn = {
  NULL: 0,
  UNICODESTRING: 1,
  ANSISTRING: 2,
  INT8: 3,
  UINT8: 4,
  INT16: 5,
  UINT16: 6,
  INT32: 7,
  UINT32: 8,
  INT64: 9,
  UINT64: 10,
  FLOAT: 11,
  DOUBLE: 12,
  BOOL32: 13,
  BINARY: 14,
  GUID: 15,
  POINTER: 16,
  FILETIME: 17,
  SYSTEMTIME: 18,
  SID: 19,
  HEXINT32: 20,
  HEXINT64: 21,
  COUNTEDSTRING: 22,
  COUNTEDANSISTRING: 23,
  STRUCT: 24,
  COUNTEDBINARY: 25,

  // Flags (upper bits)
  CCOUNT: 32,
  VCCOUNT: 64,
  CHAIN: 128,
};

/**
 * Parse TraceLogging metadata from extended data bytes.
 * @param {Uint8Array} data
 * @returns {{ name: string, fields: Array<{ name: string, tagIn: number, tagOut: number|null }> }}
 */
function parseTraceLoggingMetadata(data) {
  const reader = new BinaryReader(data);
  const size = reader.readUint16();
  const tag = reader.readUint8();

  // Optional unknown byte if high bit set
  if (tag & 0x80) {
    reader.readUint8();
  }

  const name = reader.readCString();
  const fields = [];

  while (reader.remaining > 0) {
    const fieldName = reader.readCString();
    const tagIn = reader.readUint8();

    let tagOut = null;
    if (tagIn & TagIn.CHAIN) {
      tagOut = reader.readUint8();
      // If tagOut also has high bit set, read additional 4 bytes
      if (tagOut & 0x80) {
        reader.readUint32();
      }
    }

    fields.push({ name: fieldName, tagIn, tagOut });
  }

  return { name, fields };
}

/**
 * Read a single TraceLogging field value from the stream.
 * @param {BinaryReader} reader
 * @param {number} tag
 * @returns {*}
 */
function readField(reader, tag) {
  const fieldType = tag & 0x1f;

  switch (fieldType) {
    case TagIn.UNICODESTRING: {
      // Read null-terminated UTF-16LE string
      return reader.readWString();
    }
    case TagIn.ANSISTRING: {
      return reader.readCString();
    }
    case TagIn.COUNTEDANSISTRING: {
      const length = reader.readUint16();
      const bytes = reader.readBytes(length);
      return new TextDecoder('ascii').decode(bytes);
    }
    case TagIn.COUNTEDSTRING: {
      const length = reader.readUint16();
      const bytes = reader.readBytes(length);
      return new TextDecoder('utf-16le').decode(bytes);
    }
    case TagIn.INT8:
      return reader.readInt8();
    case TagIn.UINT8:
      return reader.readUint8();
    case TagIn.INT16:
      return reader.readInt16();
    case TagIn.UINT16:
      return reader.readUint16();
    case TagIn.INT32:
      return reader.readInt32();
    case TagIn.UINT32:
    case TagIn.HEXINT32:
      return reader.readUint32();
    case TagIn.INT64:
      return reader.readInt64();
    case TagIn.UINT64:
    case TagIn.HEXINT64:
      return reader.readUint64();
    case TagIn.FLOAT:
      return reader.readFloat32();
    case TagIn.DOUBLE:
      return reader.readFloat64();
    case TagIn.BOOL32:
      return reader.readInt32() !== 0;
    case TagIn.BINARY:
      return readArrayField(reader, TagIn.UINT8);
    case TagIn.COUNTEDBINARY: {
      const length = reader.readUint16();
      return reader.readBytesCopy(length);
    }
    case TagIn.GUID:
      return reader.readGuid();
    case TagIn.FILETIME:
      return reader.readUint64();
    case TagIn.SYSTEMTIME:
      return reader.readSystemTime();
    case TagIn.SID: {
      // SID: revision(1) + subAuthorityCount(1) + identifierAuthority(6) + subAuthorities(4*count)
      const revision = reader.readUint8();
      const subAuthorityCount = reader.readUint8();
      const identifierAuthority = reader.readBytesCopy(6);
      const subAuthorities = [];
      for (let i = 0; i < subAuthorityCount; i++) {
        subAuthorities.push(reader.readUint32());
      }
      return { revision, subAuthorityCount, identifierAuthority, subAuthorities };
    }
    case TagIn.POINTER:
      // Pointers are typically 8 bytes in 64-bit traces
      return reader.readUint64();
    case TagIn.STRUCT:
      // Structs are handled at a higher level; the field itself has no data
      return null;
    default:
      throw new TraceLoggingUnhandledTag(tag);
  }
}

/**
 * Read an array field: 2-byte count prefix followed by repeated elements.
 * @param {BinaryReader} reader
 * @param {number} tag
 * @returns {Array}
 */
function readArrayField(reader, tag) {
  const count = reader.readUint16();
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push(readField(reader, tag));
  }
  return result;
}

/**
 * Parse a TraceLogging event from an EventRecord.
 * @param {object} eventRecord - Parsed EventRecord from records.js
 * @returns {{ name: string, fields: Object<string, *>, metadata: object }}
 */
function parseTraceLoggingEvent(eventRecord) {
  if (!eventRecord.extendedData) {
    throw new TraceLoggingMetaDataNotFound();
  }

  // Find the TraceLogging metadata (ext_type === 11)
  const metadataItem = eventRecord.extendedData.find(ed => ed.extType === 11);
  if (!metadataItem) {
    throw new TraceLoggingMetaDataNotFound();
  }

  const metadata = parseTraceLoggingMetadata(metadataItem.dataItem);
  const reader = new BinaryReader(eventRecord.userData);
  const fields = {};

  for (const field of metadata.fields) {
    try {
      if (field.tagIn & TagIn.CCOUNT || field.tagIn & TagIn.VCCOUNT) {
        fields[field.name] = readArrayField(reader, field.tagIn);
      } else {
        fields[field.name] = readField(reader, field.tagIn);
      }
    } catch (e) {
      // If we run out of data, store what we have
      if (e instanceof RangeError || e.message === 'no more data in stream') {
        break;
      }
      throw e;
    }
  }

  return {
    name: metadata.name,
    fields,
    metadata,
  };
}

module.exports = {
  TagIn,
  parseTraceLoggingMetadata,
  parseTraceLoggingEvent,
  readField,
  readArrayField,
};
