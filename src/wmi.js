/**
 * WMI trace header structures.
 * Ported from etl/wmi.py
 *
 * @see https://www.geoffchappell.com/studies/windows/km/ntoskrnl/api/etw/tracelog/wmi_buffer_header.htm
 */
const { BinaryReader } = require('./binary-reader');

/** WMI buffer header size in bytes (fixed). */
const WMI_BUFFER_HEADER_SIZE = 72;

/**
 * Parse the WnodeHeader (40 bytes) + WmiBufferHeader extensions (32 bytes).
 * Total: 72 bytes.
 * @param {BinaryReader} reader
 */
function readWmiBufferHeader(reader) {
  // WnodeHeader (40 bytes)
  const bufferSize = reader.readUint32();
  const savedOffset = reader.readUint32();
  const currentOffset = reader.readUint32();
  const referenceCount = reader.readInt32();
  const timestamp = reader.readUint64();
  const sequenceNumber = reader.readUint64();

  // clock is 8 bytes: 3-bit type + 61-bit frequency (little-endian BitStruct)
  const clockRaw = reader.readUint64();
  const clockType = Number(clockRaw & 0x7n);
  const clockFrequency = Number((clockRaw >> 3n) & ((1n << 61n) - 1n));

  // EtwBufferContext
  const processorIndex = reader.readUint16();
  const loggerId = reader.readUint16();

  const state = reader.readUint32();

  // WmiBufferHeader extension
  const offset = reader.readUint32();
  const bufferFlag = reader.readUint16();
  const bufferType = reader.readUint16();
  reader.skip(16); // padding

  return {
    bufferSize,
    savedOffset,
    currentOffset,
    referenceCount,
    timestamp,
    sequenceNumber,
    clock: { type: clockType, frequency: clockFrequency },
    processorIndex,
    loggerId,
    state,
    offset,
    bufferFlag,
    bufferType,
  };
}

/**
 * Read a WMI trace marker (4 bytes): version(2) + type(1) + flags(1).
 * Validates flags === 0xC0.
 * @param {BinaryReader} reader
 * @param {number[]} validTypes - array of valid marker type values
 * @returns {{ version: number, type: number }}
 */
function readWmiTraceMarker(reader, validTypes) {
  const version = reader.readUint16();
  const type = reader.readUint8();
  const flags = reader.readUint8();
  if (flags !== 0xc0) {
    return null;
  }
  if (validTypes && !validTypes.includes(type)) {
    return null;
  }
  return { version, type };
}

/**
 * Read a WmiTracePacket (4 bytes): size(2) + type(1) + group(1).
 * @param {BinaryReader} reader
 */
function readWmiTracePacket(reader) {
  const size = reader.readUint16();
  const type = reader.readUint8();
  const group = reader.readUint8();
  return { size, type, group };
}

// Event trace groups (from EventTraceGroup enum)
const EventTraceGroup = {
  HEADER: 0x00,
  IO: 0x01,
  MEMORY: 0x02,
  PROCESS: 0x03,
  FILE: 0x04,
  THREAD: 0x05,
  TCPIP: 0x06,
  JOB: 0x07,
  UDPIP: 0x08,
  REGISTRY: 0x09,
  DBGPRINT: 0x0a,
  CONFIG: 0x0b,
  PERFINFO: 0x0f,
  HEAP: 0x10,
  OBJECT: 0x11,
  POWER: 0x12,
  IMAGE: 0x14,
  DPC: 0x15,
  STACKWALK: 0x18,
  ALPC: 0x1a,
  SPLITIO: 0x1b,
};

module.exports = {
  WMI_BUFFER_HEADER_SIZE,
  readWmiBufferHeader,
  readWmiTraceMarker,
  readWmiTracePacket,
  EventTraceGroup,
};
