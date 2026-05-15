/**
 * Record parsers for the different ETL event types.
 * Ported from etl/event.py, etl/trace.py, etl/system.py, etl/perf.py, etl/wintrace.py
 */
const { BinaryReader } = require('./binary-reader');
const { readWmiTraceMarker, readWmiTracePacket } = require('./wmi');

// Marker type constants
const EVENT_HEADER_EVENT32 = 0x12;
const EVENT_HEADER_EVENT64 = 0x13;
const TRACE_HEADER_FULL32 = 0x0a;
const TRACE_HEADER_FULL64 = 0x14;
const SYSTEM_TRACE_MARKER_32 = 0x01;
const SYSTEM_TRACE_MARKER_64 = 0x02;
const COMPACT_TRACE_MARKER_32 = 0x03;
const COMPACT_TRACE_MARKER_64 = 0x04;
const PERFINFO_TRACE_MARKER_32 = 0x10;
const PERFINFO_TRACE_MARKER_64 = 0x11;

const SYSTEM_MARKERS = [SYSTEM_TRACE_MARKER_32, SYSTEM_TRACE_MARKER_64, COMPACT_TRACE_MARKER_32, COMPACT_TRACE_MARKER_64];
const FULL_SYSTEM_MARKERS = [SYSTEM_TRACE_MARKER_32, SYSTEM_TRACE_MARKER_64];

/**
 * Try to parse an EventRecord (ETW event with EventHeader).
 * Returns null if the marker doesn't match.
 * @param {BinaryReader} reader
 * @returns {object|null}
 */
function tryParseEventRecord(reader) {
  const mark1 = reader.tell();
  const marker = readWmiTraceMarker(reader, [EVENT_HEADER_EVENT32, EVENT_HEADER_EVENT64]);
  if (!marker) return null;

  // EventHeader flags & properties
  const flags = reader.readUint16();
  const eventProperty = reader.readUint16();
  const threadId = reader.readUint32();
  const processId = reader.readUint32();
  const timestamp = reader.readUint64();
  const providerId = reader.readGuid();

  // EventDescriptor
  const eventId = reader.readUint16();
  const version = reader.readUint8();
  const channel = reader.readUint8();
  const level = reader.readUint8();
  const opcode = reader.readUint8();
  const task = reader.readUint16();
  const keyword = reader.readUint64();

  const processorTime = reader.readUint64();
  const activityId = reader.readGuid();

  // Extended data items
  const hasExtendedInfo = !!(flags & 0x0001);
  let extendedData = null;
  if (hasExtendedInfo) {
    extendedData = [];
    let hasMore = true;
    while (hasMore) {
      const reserved1 = reader.readUint16();
      const extType = reader.readUint16();
      const reserved2 = reader.readUint16();
      const dataSize = reader.readUint16();
      const dataItem = reader.readBytesCopy(dataSize);
      // Align to 8 bytes after each extended data item
      reader.align(8);
      extendedData.push({ reserved1, extType, reserved2, dataSize, dataItem });
      hasMore = !!(reserved2 & 0x1);
    }
  }

  const mark2 = reader.tell();
  const userDataSize = marker.version - (mark2 - mark1);
  const userData = userDataSize > 0 ? reader.readBytesCopy(userDataSize) : new Uint8Array(0);

  return {
    recordType: 'EventRecord',
    marker,
    flags,
    eventProperty,
    threadId,
    processId,
    timestamp,
    providerId,
    eventDescriptor: { id: eventId, version, channel, level, opcode, task, keyword },
    processorTime,
    activityId,
    extendedData,
    userData,
  };
}

/**
 * Try to parse a TraceRecord.
 * @param {BinaryReader} reader
 * @returns {object|null}
 */
function tryParseTraceRecord(reader) {
  const mark1 = reader.tell();
  const marker = readWmiTraceMarker(reader, [TRACE_HEADER_FULL32, TRACE_HEADER_FULL64]);
  if (!marker) return null;

  const traceType = reader.readUint8();
  const traceLevel = reader.readUint8();
  const traceVersion = reader.readUint16();
  const threadId = reader.readUint32();
  const processId = reader.readUint32();
  const timestamp = reader.readUint64();
  const guid = reader.readGuid();
  const processorTime = reader.readUint64();

  const mark2 = reader.tell();
  const userDataSize = marker.version - (mark2 - mark1);
  const userData = userDataSize > 0 ? reader.readBytesCopy(userDataSize) : new Uint8Array(0);

  return {
    recordType: 'TraceRecord',
    marker,
    traceClass: { type: traceType, level: traceLevel, version: traceVersion },
    threadId,
    processId,
    timestamp,
    guid,
    processorTime,
    userData,
  };
}

/**
 * Try to parse a SystemTraceRecord.
 * @param {BinaryReader} reader
 * @returns {object|null}
 */
function tryParseSystemTraceRecord(reader) {
  const startMark = reader.tell();
  const marker = readWmiTraceMarker(reader, SYSTEM_MARKERS);
  if (!marker) return null;

  const packet = readWmiTracePacket(reader);
  const threadId = reader.readUint32();
  const processId = reader.readUint32();
  const systemTime = reader.readUint64();

  let kernelTime = null;
  let userTime = null;
  if (FULL_SYSTEM_MARKERS.includes(marker.type)) {
    kernelTime = reader.readUint32();
    userTime = reader.readUint32();
  }

  const headerSize = reader.tell() - startMark;
  const mofDataSize = packet.size - headerSize;
  const mofData = mofDataSize > 0 ? reader.readBytesCopy(mofDataSize) : new Uint8Array(0);

  return {
    recordType: 'SystemTraceRecord',
    marker,
    packet,
    threadId,
    processId,
    systemTime,
    kernelTime,
    userTime,
    mofData,
  };
}

/**
 * Try to parse a PerfInfoTraceRecord.
 * @param {BinaryReader} reader
 * @returns {object|null}
 */
function tryParsePerfInfoRecord(reader) {
  const marker = readWmiTraceMarker(reader, [PERFINFO_TRACE_MARKER_32, PERFINFO_TRACE_MARKER_64]);
  if (!marker) return null;

  const packet = readWmiTracePacket(reader);
  const timestamp = reader.readUint64();
  const mofDataSize = packet.size - 16;
  const mofData = mofDataSize > 0 ? reader.readBytesCopy(mofDataSize) : new Uint8Array(0);

  return {
    recordType: 'PerfInfoTraceRecord',
    marker,
    packet,
    timestamp,
    mofData,
  };
}

/**
 * Try to parse a WinTraceRecord.
 * @param {BinaryReader} reader
 * @returns {object|null}
 */
function tryParseWinTraceRecord(reader) {
  const mark1 = reader.tell();
  const size = reader.readUint16();
  const markerVal = reader.readUint16();
  if (markerVal !== 0x9000) {
    return null;
  }

  const eventId = reader.readUint16();
  const flags = reader.readUint16();
  const providerId = reader.readGuid();
  const threadId = reader.readUint32();
  const processId = reader.readUint32();

  const mark2 = reader.tell();
  const userDataSize = size - (mark2 - mark1);
  const userData = userDataSize > 0 ? reader.readBytesCopy(userDataSize) : new Uint8Array(0);

  return {
    recordType: 'WinTraceRecord',
    size,
    eventId,
    flags,
    providerId,
    threadId,
    processId,
    userData,
  };
}

/**
 * Parse a single record from the chunk payload.
 * Tries each record type in order (matching Python's Select behavior).
 * @param {BinaryReader} reader
 * @returns {object}
 */
function parseRecord(reader) {
  const startOffset = reader.tell();

  // Try parsers in priority order (matching Python's Select)
  const parsers = [
    tryParsePerfInfoRecord,
    tryParseEventRecord,
    tryParseTraceRecord,
    tryParseSystemTraceRecord,
    tryParseWinTraceRecord,
  ];

  for (const parser of parsers) {
    reader.seek(startOffset);
    try {
      const result = parser(reader);
      if (result) {
        // Align to 8 bytes after each record
        reader.align(8);
        return result;
      }
    } catch (e) {
      // Try next parser
    }
  }

  throw new Error(`Failed to parse record at offset ${startOffset}`);
}

/**
 * Parse all records from a chunk payload.
 * @param {Uint8Array} payload
 * @returns {object[]}
 */
function parseChunkPayload(payload) {
  const reader = new BinaryReader(payload);
  const records = [];
  while (reader.remaining > 0) {
    try {
      records.push(parseRecord(reader));
    } catch (e) {
      break;
    }
  }
  return records;
}

module.exports = {
  parseRecord,
  parseChunkPayload,
  tryParseEventRecord,
  tryParseTraceRecord,
  tryParseSystemTraceRecord,
  tryParsePerfInfoRecord,
  tryParseWinTraceRecord,
};
