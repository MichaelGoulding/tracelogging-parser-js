/**
 * Main ETL file parser.
 * Ported from etl/etl.py
 *
 * Usage:
 *   import { parseEtlFile } from 'etl-js';
 *
 *   const buffer = await file.arrayBuffer();
 *   const result = parseEtlFile(buffer);
 *   for (const event of result.events) {
 *     console.log(event.recordType, event);
 *   }
 */
const { BinaryReader } = require('./binary-reader');
const { readWmiBufferHeader, WMI_BUFFER_HEADER_SIZE, EventTraceGroup } = require('./wmi');
const { parseChunkPayload } = require('./records');
const { parseTraceLoggingEvent } = require('./tracelogging');
const { InvalidEtlFileHeader, ParseError, TraceLoggingMetaDataNotFound } = require('./errors');

/**
 * Parse ETL chunks from the raw file buffer.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Array<{ header: object, payload: Uint8Array }>}
 */
function parseChunks(buffer) {
  const reader = new BinaryReader(buffer);
  const chunks = [];

  while (reader.remaining >= WMI_BUFFER_HEADER_SIZE) {
    const chunkStart = reader.tell();
    const header = readWmiBufferHeader(reader);

    const payloadSize = header.savedOffset - WMI_BUFFER_HEADER_SIZE;
    if (payloadSize < 0 || payloadSize > reader.remaining) {
      break;
    }
    const payload = reader.readBytesCopy(payloadSize);

    // Skip padding to reach the next chunk
    const paddingSize = header.bufferSize - header.savedOffset;
    if (paddingSize > 0 && paddingSize <= reader.remaining) {
      reader.skip(paddingSize);
    } else if (paddingSize > reader.remaining) {
      // Last chunk may have truncated padding
      reader.seek(reader.length);
    }

    chunks.push({ header, payload });
  }

  return chunks;
}

/**
 * Validate the first chunk as an ETL file header.
 * Returns the parsed header MOF data or throws.
 * @param {Uint8Array} payload
 * @returns {object}
 */
function validateFileHeader(payload) {
  const records = parseChunkPayload(payload);
  if (records.length === 0 || records[0].recordType !== 'SystemTraceRecord') {
    throw new InvalidEtlFileHeader();
  }

  const record = records[0];
  // Must be EVENT_TRACE_GROUP_HEADER group
  if (record.packet.group !== EventTraceGroup.HEADER) {
    throw new InvalidEtlFileHeader();
  }

  // Parse the header MOF data
  const mofReader = new BinaryReader(record.mofData);
  try {
    const fileHeader = {
      bufferSize: mofReader.readUint32(),
      version: mofReader.readUint32(),
      providerVersion: mofReader.readUint32(),
      numberOfProcessors: mofReader.readUint32(),
      endTime: mofReader.readUint64(),
      timerResolution: mofReader.readUint32(),
      maxFileSize: mofReader.readUint32(),
      logFileMode: mofReader.readUint32(),
      buffersWritten: mofReader.readUint32(),
      startBuffers: mofReader.readUint32(),
      pointerSize: mofReader.readUint32(),
      eventsLost: mofReader.readUint32(),
      cpuSpeed: mofReader.readUint32(),
    };
    return fileHeader;
  } catch (e) {
    throw new InvalidEtlFileHeader();
  }
}

/**
 * @typedef {object} EtlEvent
 * @property {string} recordType - One of: EventRecord, TraceRecord, SystemTraceRecord, PerfInfoTraceRecord, WinTraceRecord
 * @property {number} processId
 * @property {number} threadId
 * @property {BigInt} timestamp
 * @property {string} [providerId] - GUID string (EventRecord only)
 * @property {object} [eventDescriptor] - Event descriptor (EventRecord only)
 * @property {Uint8Array} userData - Raw user data bytes
 * @property {object} [traceLogging] - Parsed TraceLogging data (if applicable)
 */

/**
 * Parse an ETL file and return all events.
 *
 * @param {ArrayBuffer|Uint8Array} buffer - Raw ETL file contents
 * @param {object} [options]
 * @param {boolean} [options.autoParseTraceLogging=true] - Automatically parse TraceLogging events
 * @param {boolean} [options.includeHeader=false] - Include the file header in results
 * @param {function} [options.onEvent] - Callback for each event (for streaming-style processing)
 * @param {function} [options.onError] - Callback for parse errors (default: skip silently)
 * @returns {{ header: object, events: EtlEvent[] }}
 */
function parseEtlFile(buffer, options = {}) {
  const {
    autoParseTraceLogging = true,
    includeHeader = false,
    onEvent,
    onError,
  } = options;

  const chunks = parseChunks(buffer);
  if (chunks.length === 0) {
    throw new InvalidEtlFileHeader();
  }

  // Validate and parse the file header (first chunk)
  let header;
  try {
    header = validateFileHeader(chunks[0].payload);
  } catch (e) {
    if (e instanceof InvalidEtlFileHeader) {
      throw e;
    }
    throw new InvalidEtlFileHeader();
  }

  const events = [];
  const startIdx = includeHeader ? 0 : 1;

  for (let i = startIdx; i < chunks.length; i++) {
    let records;
    try {
      records = parseChunkPayload(chunks[i].payload);
    } catch (e) {
      if (onError) onError(e, i);
      continue;
    }

    for (const record of records) {
      // Auto-parse TraceLogging for EventRecords
      if (autoParseTraceLogging && record.recordType === 'EventRecord') {
        try {
          record.traceLogging = parseTraceLoggingEvent(record);
        } catch (e) {
          if (!(e instanceof TraceLoggingMetaDataNotFound)) {
            if (onError) onError(e, i);
          }
          // Not a TraceLogging event or parse error — that's fine
        }
      }

      if (onEvent) {
        onEvent(record);
      }
      events.push(record);
    }
  }

  // Sort events by timestamp (matching tracefmt behavior)
  events.sort((a, b) => {
    const ta = a.timestamp ?? 0n;
    const tb = b.timestamp ?? 0n;
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  return { header, events };
}

/**
 * Convenience: parse an ETL file and return only TraceLogging events.
 *
 * @param {ArrayBuffer|Uint8Array} buffer - Raw ETL file contents
 * @param {object} [options]
 * @param {function} [options.onError] - Callback for parse errors
 * @returns {Array<{ name: string, fields: object, providerId: string, timestamp: BigInt, processId: number, threadId: number, eventDescriptor: object }>}
 */
function parseTraceLoggingEvents(buffer, options = {}) {
  const { header, events } = parseEtlFile(buffer, { ...options, autoParseTraceLogging: true });
  return events
    .filter(e => e.traceLogging)
    .map(e => ({
      eventName: e.traceLogging.name,
      fields: e.traceLogging.fields,
      providerId: e.providerId,
      timestamp: e.timestamp,
      processId: e.processId,
      threadId: e.threadId,
      eventDescriptor: e.eventDescriptor,
    }));
}

module.exports = {
  parseEtlFile,
  parseTraceLoggingEvents,
  parseChunks,
  validateFileHeader,
};
