/**
 * Tests for etl-js library.
 * Uses synthetic binary data to validate parsing logic without needing real ETL files.
 */
const { BinaryReader } = require('../src/binary-reader');
const { parseTraceLoggingMetadata, parseTraceLoggingEvent, TagIn } = require('../src/tracelogging');
const { tryParseEventRecord, tryParseSystemTraceRecord, tryParsePerfInfoRecord } = require('../src/records');
const { readWmiBufferHeader, WMI_BUFFER_HEADER_SIZE } = require('../src/wmi');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

// ============================================================
// BinaryReader tests
// ============================================================
console.log('\n=== BinaryReader tests ===');

{
  const buf = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  const reader = new BinaryReader(buf);

  assertEqual(reader.readUint8(), 1, 'readUint8');
  assertEqual(reader.readUint8(), 2, 'readUint8 second');
  reader.seek(0);

  assertEqual(reader.readUint16(), 0x0201, 'readUint16 little-endian');
  reader.seek(0);

  assertEqual(reader.readUint32(), 0x04030201, 'readUint32 little-endian');
  reader.seek(0);

  const u64 = reader.readUint64();
  assertEqual(u64, 0x0807060504030201n, 'readUint64 little-endian');
}

{
  const buf = new Uint8Array([0xFF, 0x7F]); // 32767
  const reader = new BinaryReader(buf);
  assertEqual(reader.readInt16(), 32767, 'readInt16 positive');

  const buf2 = new Uint8Array([0x00, 0x80]); // -32768
  const reader2 = new BinaryReader(buf2);
  assertEqual(reader2.readInt16(), -32768, 'readInt16 negative');
}

{
  // GUID test: {12345678-1234-5678-9ABC-DEF012345678}
  const guidBytes = new Uint8Array([
    0x78, 0x56, 0x34, 0x12,  // data1 LE
    0x34, 0x12,              // data2 LE
    0x78, 0x56,              // data3 LE
    0x9A, 0xBC, 0xDE, 0xF0, 0x12, 0x34, 0x56, 0x78  // data4
  ]);
  const reader = new BinaryReader(guidBytes);
  const guid = reader.readGuid();
  assertEqual(guid, '12345678-1234-5678-9abc-def012345678', 'readGuid');
}

{
  // CString test
  const buf = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x00]); // "Hello\0"
  const reader = new BinaryReader(buf);
  assertEqual(reader.readCString(), 'Hello', 'readCString');
}

{
  // WString test (UTF-16LE null-terminated)
  const buf = new Uint8Array([
    0x48, 0x00, 0x69, 0x00, 0x00, 0x00  // "Hi\0\0"
  ]);
  const reader = new BinaryReader(buf);
  assertEqual(reader.readWString(), 'Hi', 'readWString');
}

{
  // Alignment test
  const reader = new BinaryReader(new Uint8Array(16));
  reader.seek(3);
  reader.align(8);
  assertEqual(reader.tell(), 8, 'align to 8 from 3');

  reader.seek(8);
  reader.align(8);
  assertEqual(reader.tell(), 8, 'align to 8 from 8 (already aligned)');

  reader.seek(1);
  reader.align(4);
  assertEqual(reader.tell(), 4, 'align to 4 from 1');
}

// ============================================================
// TraceLogging metadata parser tests
// ============================================================
console.log('\n=== TraceLogging metadata tests ===');

{
  // Build a synthetic metadata blob:
  // size(2) + tag(1) + name(cstring) + fields...
  const parts = [];

  // Provider name
  const providerName = 'TestProvider';
  const nameBytes = new TextEncoder().encode(providerName);

  // Field 1: "Message" as UNICODESTRING
  const field1Name = new TextEncoder().encode('Message');

  // Field 2: "Level" as UINT32
  const field2Name = new TextEncoder().encode('Level');

  // Calculate total size
  const totalSize = 2 + 1 + nameBytes.length + 1 + // size + tag + name + null
    field1Name.length + 1 + 1 +  // field1 name + null + tagIn
    field2Name.length + 1 + 1;    // field2 name + null + tagIn

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  let offset = 0;

  view.setUint16(offset, totalSize, true); offset += 2;
  buf[offset++] = 0x00; // tag (no high bit)
  buf.set(nameBytes, offset); offset += nameBytes.length;
  buf[offset++] = 0x00; // null terminator

  // Field 1: Message / UNICODESTRING (tag = 1)
  buf.set(field1Name, offset); offset += field1Name.length;
  buf[offset++] = 0x00;
  buf[offset++] = TagIn.UNICODESTRING;

  // Field 2: Level / UINT32 (tag = 8)
  buf.set(field2Name, offset); offset += field2Name.length;
  buf[offset++] = 0x00;
  buf[offset++] = TagIn.UINT32;

  const metadata = parseTraceLoggingMetadata(buf);
  assertEqual(metadata.name, 'TestProvider', 'metadata provider name');
  assertEqual(metadata.fields.length, 2, 'metadata field count');
  assertEqual(metadata.fields[0].name, 'Message', 'field 0 name');
  assertEqual(metadata.fields[0].tagIn, TagIn.UNICODESTRING, 'field 0 tag');
  assertEqual(metadata.fields[1].name, 'Level', 'field 1 name');
  assertEqual(metadata.fields[1].tagIn, TagIn.UINT32, 'field 1 tag');
}

// ============================================================
// TraceLogging event parsing test (with synthetic EventRecord)
// ============================================================
console.log('\n=== TraceLogging event parsing tests ===');

{
  // Build metadata for a single UINT32 field named "Value"
  const fieldName = new TextEncoder().encode('Value');
  const providerName = new TextEncoder().encode('TestProv');
  const metaSize = 2 + 1 + providerName.length + 1 + fieldName.length + 1 + 1;
  const metaBuf = new Uint8Array(metaSize);
  const metaView = new DataView(metaBuf.buffer);
  let off = 0;
  metaView.setUint16(off, metaSize, true); off += 2;
  metaBuf[off++] = 0x00;
  metaBuf.set(providerName, off); off += providerName.length;
  metaBuf[off++] = 0x00;
  metaBuf.set(fieldName, off); off += fieldName.length;
  metaBuf[off++] = 0x00;
  metaBuf[off++] = TagIn.UINT32;

  // User data: a single UINT32 value = 42
  const userBuf = new Uint8Array(4);
  new DataView(userBuf.buffer).setUint32(0, 42, true);

  // Simulate EventRecord with ext_type 11
  const fakeRecord = {
    recordType: 'EventRecord',
    extendedData: [
      { extType: 11, dataItem: metaBuf }
    ],
    userData: userBuf,
  };

  const result = parseTraceLoggingEvent(fakeRecord);
  assertEqual(result.name, 'TestProv', 'TL event provider name');
  assertEqual(result.fields['Value'], 42, 'TL event UINT32 value');
}

{
  // Test string field
  const fieldName = new TextEncoder().encode('Msg');
  const providerName = new TextEncoder().encode('P');
  const metaSize = 2 + 1 + providerName.length + 1 + fieldName.length + 1 + 1;
  const metaBuf = new Uint8Array(metaSize);
  const metaView = new DataView(metaBuf.buffer);
  let off = 0;
  metaView.setUint16(off, metaSize, true); off += 2;
  metaBuf[off++] = 0x00;
  metaBuf.set(providerName, off); off += providerName.length;
  metaBuf[off++] = 0x00;
  metaBuf.set(fieldName, off); off += fieldName.length;
  metaBuf[off++] = 0x00;
  metaBuf[off++] = TagIn.ANSISTRING;

  // User data: "hello\0"
  const userBuf = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00]);

  const fakeRecord = {
    recordType: 'EventRecord',
    extendedData: [{ extType: 11, dataItem: metaBuf }],
    userData: userBuf,
  };

  const result = parseTraceLoggingEvent(fakeRecord);
  assertEqual(result.fields['Msg'], 'hello', 'TL event ANSISTRING value');
}

// ============================================================
// WmiBufferHeader test
// ============================================================
console.log('\n=== WmiBufferHeader tests ===');

{
  const buf = new Uint8Array(WMI_BUFFER_HEADER_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 65536, true);  // bufferSize
  view.setUint32(4, 200, true);    // savedOffset
  view.setUint32(8, 200, true);    // currentOffset
  view.setInt32(12, 1, true);      // referenceCount
  // timestamp, sequenceNumber, clock (skip)
  // processorIndex at offset 40, loggerId at offset 42
  view.setUint16(40, 3, true);     // processorIndex
  view.setUint16(42, 1, true);     // loggerId

  const reader = new BinaryReader(buf);
  const header = readWmiBufferHeader(reader);
  assertEqual(header.bufferSize, 65536, 'bufferSize');
  assertEqual(header.savedOffset, 200, 'savedOffset');
  assertEqual(header.processorIndex, 3, 'processorIndex');
  assertEqual(header.loggerId, 1, 'loggerId');
}

// ============================================================
// Record parser tests
// ============================================================
console.log('\n=== Record parser tests ===');

{
  // Build a synthetic EventRecord
  // marker(4) + flags(2) + eventProperty(2) + threadId(4) + processId(4) + timestamp(8)
  // + providerId(16) + eventDescriptor(16) + processorTime(8) + activityId(16)
  // Total header = 80 bytes, marker.version = total record size
  const totalSize = 80; // just the header, no user data
  const buf = new Uint8Array(totalSize + 8); // extra for alignment padding
  const view = new DataView(buf.buffer);
  let off = 0;

  // WmiTraceMarker: version(2) + type(1) + flags(1)
  view.setUint16(off, totalSize, true); off += 2; // version = total size
  buf[off++] = 0x12; // EVENT_HEADER_EVENT32
  buf[off++] = 0xC0; // flags

  // EventHeader flags (no extended info)
  view.setUint16(off, 0, true); off += 2;
  // eventProperty
  view.setUint16(off, 0, true); off += 2;
  // threadId
  view.setUint32(off, 1234, true); off += 4;
  // processId
  view.setUint32(off, 5678, true); off += 4;
  // timestamp
  view.setBigUint64(off, 999n, true); off += 8;
  // providerId (16 bytes GUID)
  off += 16;
  // eventDescriptor (16 bytes)
  view.setUint16(off, 100, true); off += 2; // Id
  buf[off++] = 1; // Version
  buf[off++] = 0; // Channel
  buf[off++] = 4; // Level
  buf[off++] = 0; // Opcode
  view.setUint16(off, 0, true); off += 2; // Task
  view.setBigUint64(off, 0n, true); off += 8; // Keyword
  // processorTime
  view.setBigUint64(off, 0n, true); off += 8;
  // activityId (16 bytes)
  off += 16;

  const reader = new BinaryReader(buf);
  const record = tryParseEventRecord(reader);
  assert(record !== null, 'EventRecord parsed');
  assertEqual(record.recordType, 'EventRecord', 'record type');
  assertEqual(record.threadId, 1234, 'threadId');
  assertEqual(record.processId, 5678, 'processId');
  assertEqual(record.eventDescriptor.id, 100, 'event id');
  assertEqual(record.eventDescriptor.level, 4, 'event level');
}

// ============================================================
// TraceLogging field type tests
// ============================================================
console.log('\n=== TraceLogging field type tests ===');

// Helper: build a TL metadata buffer for a single field
function buildTlMeta(providerName, fieldName, tagIn) {
  const prov = new TextEncoder().encode(providerName);
  const field = new TextEncoder().encode(fieldName);
  const size = 2 + 1 + prov.length + 1 + field.length + 1 + 1;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let off = 0;
  view.setUint16(off, size, true); off += 2;
  buf[off++] = 0x00;
  buf.set(prov, off); off += prov.length;
  buf[off++] = 0x00;
  buf.set(field, off); off += field.length;
  buf[off++] = 0x00;
  buf[off++] = tagIn;
  return buf;
}

function makeTlRecord(metaBuf, userBuf) {
  return {
    recordType: 'EventRecord',
    extendedData: [{ extType: 11, dataItem: metaBuf }],
    userData: userBuf,
  };
}

{
  // UNICODESTRING: "Hi" in UTF-16LE + null terminator
  const meta = buildTlMeta('P', 'Str', TagIn.UNICODESTRING);
  const userData = new Uint8Array([0x48, 0x00, 0x69, 0x00, 0x00, 0x00]);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, userData));
  assertEqual(result.fields['Str'], 'Hi', 'TL UNICODESTRING');
}

{
  // INT8
  const meta = buildTlMeta('P', 'V', TagIn.INT8);
  const userData = new Uint8Array([0xFE]); // -2 signed
  const result = parseTraceLoggingEvent(makeTlRecord(meta, userData));
  assertEqual(result.fields['V'], -2, 'TL INT8');
}

{
  // UINT16
  const meta = buildTlMeta('P', 'V', TagIn.UINT16);
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, 1234, true);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assertEqual(result.fields['V'], 1234, 'TL UINT16');
}

{
  // INT64
  const meta = buildTlMeta('P', 'V', TagIn.INT64);
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, -999n, true);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assertEqual(result.fields['V'], -999n, 'TL INT64');
}

{
  // UINT64
  const meta = buildTlMeta('P', 'V', TagIn.UINT64);
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, 0xFFFFFFFFFFFFFFFFn, true);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assertEqual(result.fields['V'], 0xFFFFFFFFFFFFFFFFn, 'TL UINT64');
}

{
  // FLOAT
  const meta = buildTlMeta('P', 'V', TagIn.FLOAT);
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setFloat32(0, 3.14, true);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assert(Math.abs(result.fields['V'] - 3.14) < 0.001, 'TL FLOAT');
}

{
  // DOUBLE
  const meta = buildTlMeta('P', 'V', TagIn.DOUBLE);
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, 2.718281828, true);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assert(Math.abs(result.fields['V'] - 2.718281828) < 1e-9, 'TL DOUBLE');
}

{
  // BOOL32 true
  const meta = buildTlMeta('P', 'V', TagIn.BOOL32);
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setInt32(0, 1, true);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assertEqual(result.fields['V'], true, 'TL BOOL32 true');
}

{
  // BOOL32 false
  const meta = buildTlMeta('P', 'V', TagIn.BOOL32);
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setInt32(0, 0, true);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assertEqual(result.fields['V'], false, 'TL BOOL32 false');
}

{
  // HEXINT32
  const meta = buildTlMeta('P', 'V', TagIn.HEXINT32);
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, 0xDEADBEEF, true);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assertEqual(result.fields['V'], 0xDEADBEEF, 'TL HEXINT32');
}

{
  // HEXINT64
  const meta = buildTlMeta('P', 'V', TagIn.HEXINT64);
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, 0xCAFEBABEn, true);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assertEqual(result.fields['V'], 0xCAFEBABEn, 'TL HEXINT64');
}

{
  // GUID
  const meta = buildTlMeta('P', 'V', TagIn.GUID);
  const buf = new Uint8Array([
    0x78, 0x56, 0x34, 0x12,
    0x34, 0x12,
    0x78, 0x56,
    0x9A, 0xBC, 0xDE, 0xF0, 0x12, 0x34, 0x56, 0x78,
  ]);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assertEqual(result.fields['V'], '12345678-1234-5678-9abc-def012345678', 'TL GUID');
}

{
  // COUNTEDANSISTRING
  const meta = buildTlMeta('P', 'V', TagIn.COUNTEDANSISTRING);
  const str = 'test';
  const buf = new Uint8Array(2 + str.length);
  new DataView(buf.buffer).setUint16(0, str.length, true);
  buf.set(new TextEncoder().encode(str), 2);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assertEqual(result.fields['V'], 'test', 'TL COUNTEDANSISTRING');
}

{
  // COUNTEDSTRING (UTF-16LE)
  const meta = buildTlMeta('P', 'V', TagIn.COUNTEDSTRING);
  const encoded = new TextEncoder().encode('Hi'); // we need UTF-16LE
  const utf16 = new Uint8Array([0x48, 0x00, 0x69, 0x00]); // "Hi" in UTF-16LE
  const buf = new Uint8Array(2 + utf16.length);
  new DataView(buf.buffer).setUint16(0, utf16.length, true);
  buf.set(utf16, 2);
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assertEqual(result.fields['V'], 'Hi', 'TL COUNTEDSTRING');
}

{
  // SYSTEMTIME
  const meta = buildTlMeta('P', 'V', TagIn.SYSTEMTIME);
  const buf = new Uint8Array(16);
  const view = new DataView(buf.buffer);
  view.setInt16(0, 2026, true);  // year
  view.setInt16(2, 5, true);     // month
  view.setInt16(4, 4, true);     // dayOfWeek
  view.setInt16(6, 15, true);    // day
  view.setInt16(8, 10, true);    // hour
  view.setInt16(10, 30, true);   // minute
  view.setInt16(12, 45, true);   // second
  view.setInt16(14, 123, true);  // milliseconds
  const result = parseTraceLoggingEvent(makeTlRecord(meta, buf));
  assertEqual(result.fields['V'].year, 2026, 'TL SYSTEMTIME year');
  assertEqual(result.fields['V'].month, 5, 'TL SYSTEMTIME month');
  assertEqual(result.fields['V'].day, 15, 'TL SYSTEMTIME day');
  assertEqual(result.fields['V'].hour, 10, 'TL SYSTEMTIME hour');
}

// ============================================================
// TraceLogging array field tests
// ============================================================
console.log('\n=== TraceLogging array tests ===');

{
  // Array of UINT32 via CCOUNT flag
  const prov = new TextEncoder().encode('P');
  const field = new TextEncoder().encode('Arr');
  const tagIn = TagIn.UINT32 | TagIn.CCOUNT;
  const size = 2 + 1 + prov.length + 1 + field.length + 1 + 1;
  const metaBuf = new Uint8Array(size);
  const metaView = new DataView(metaBuf.buffer);
  let off = 0;
  metaView.setUint16(off, size, true); off += 2;
  metaBuf[off++] = 0x00;
  metaBuf.set(prov, off); off += prov.length;
  metaBuf[off++] = 0x00;
  metaBuf.set(field, off); off += field.length;
  metaBuf[off++] = 0x00;
  metaBuf[off++] = tagIn;

  // User data: count=3, then three UINT32 values
  const userData = new Uint8Array(2 + 4 * 3);
  const udView = new DataView(userData.buffer);
  udView.setUint16(0, 3, true);
  udView.setUint32(2, 10, true);
  udView.setUint32(6, 20, true);
  udView.setUint32(10, 30, true);

  const result = parseTraceLoggingEvent(makeTlRecord(metaBuf, userData));
  assert(Array.isArray(result.fields['Arr']), 'TL array is array');
  assertEqual(result.fields['Arr'].length, 3, 'TL array length');
  assertEqual(result.fields['Arr'][0], 10, 'TL array[0]');
  assertEqual(result.fields['Arr'][1], 20, 'TL array[1]');
  assertEqual(result.fields['Arr'][2], 30, 'TL array[2]');
}

// ============================================================
// TraceLogging error handling tests
// ============================================================
console.log('\n=== TraceLogging error tests ===');

{
  // No extended data → TraceLoggingMetaDataNotFound
  let threw = false;
  try {
    parseTraceLoggingEvent({ recordType: 'EventRecord', extendedData: null, userData: new Uint8Array(0) });
  } catch (e) {
    threw = e.name === 'TraceLoggingMetaDataNotFound';
  }
  assert(threw, 'throws TraceLoggingMetaDataNotFound when no extendedData');
}

{
  // Extended data but no ext_type 11
  let threw = false;
  try {
    parseTraceLoggingEvent({
      recordType: 'EventRecord',
      extendedData: [{ extType: 5, dataItem: new Uint8Array(4) }],
      userData: new Uint8Array(0),
    });
  } catch (e) {
    threw = e.name === 'TraceLoggingMetaDataNotFound';
  }
  assert(threw, 'throws TraceLoggingMetaDataNotFound when no ext_type 11');
}

// ============================================================
// Other record parser tests
// ============================================================
console.log('\n=== Other record parser tests ===');

{
  // PerfInfoTraceRecord
  const totalSize = 16 + 8; // header(4+4+8) + 8 bytes mof_data
  const buf = new Uint8Array(totalSize + 8);
  const view = new DataView(buf.buffer);
  let off = 0;
  // marker: version(2) + type(1) + flags(1)
  view.setUint16(off, 0, true); off += 2;
  buf[off++] = 0x10; // PERFINFO_TRACE_MARKER_32
  buf[off++] = 0xC0;
  // WmiTracePacket: size(2) + type(1) + group(1)
  view.setUint16(off, totalSize, true); off += 2;
  buf[off++] = 0;
  buf[off++] = 0x0F; // PERFINFO group
  // timestamp
  view.setBigUint64(off, 12345n, true); off += 8;
  // mof_data (8 bytes)
  buf[off++] = 0xAA;

  const reader = new BinaryReader(buf);
  const record = tryParsePerfInfoRecord(reader);
  assert(record !== null, 'PerfInfoRecord parsed');
  assertEqual(record.recordType, 'PerfInfoTraceRecord', 'PerfInfo record type');
  assertEqual(record.timestamp, 12345n, 'PerfInfo timestamp');
  assertEqual(record.mofData.length, totalSize - 16, 'PerfInfo mofData size');
}

{
  // SystemTraceRecord (full marker with kernel/user time)
  const packetSize = 4 + 4 + 4 + 4 + 8 + 4 + 4 + 4; // marker + packet + tid + pid + time + kernel + user + mofdata
  const buf = new Uint8Array(packetSize + 8);
  const view = new DataView(buf.buffer);
  let off = 0;
  // marker
  view.setUint16(off, 0, true); off += 2;
  buf[off++] = 0x01; // SYSTEM_TRACE_MARKER_32
  buf[off++] = 0xC0;
  // packet: size includes everything from marker onward
  view.setUint16(off, packetSize, true); off += 2;
  buf[off++] = 1; // type
  buf[off++] = 0x03; // PROCESS group
  // threadId, processId
  view.setUint32(off, 100, true); off += 4;
  view.setUint32(off, 200, true); off += 4;
  // systemTime
  view.setBigUint64(off, 77777n, true); off += 8;
  // kernelTime, userTime (present for full system markers)
  view.setUint32(off, 50, true); off += 4;
  view.setUint32(off, 60, true); off += 4;

  const reader = new BinaryReader(buf);
  const record = tryParseSystemTraceRecord(reader);
  assert(record !== null, 'SystemTraceRecord parsed');
  assertEqual(record.recordType, 'SystemTraceRecord', 'System record type');
  assertEqual(record.threadId, 100, 'System threadId');
  assertEqual(record.processId, 200, 'System processId');
  assertEqual(record.systemTime, 77777n, 'System systemTime');
  assertEqual(record.kernelTime, 50, 'System kernelTime');
  assertEqual(record.userTime, 60, 'System userTime');
}

{
  // WinTraceRecord
  const headerSize = 2 + 2 + 2 + 2 + 16 + 4 + 4; // 32 bytes
  const userDataLen = 6;
  const totalSize = headerSize + userDataLen;
  const buf = new Uint8Array(totalSize + 8);
  const view = new DataView(buf.buffer);
  let off = 0;
  view.setUint16(off, totalSize, true); off += 2; // size
  view.setUint16(off, 0x9000, true); off += 2;    // marker
  view.setUint16(off, 42, true); off += 2;        // eventId
  view.setUint16(off, 0, true); off += 2;         // flags
  off += 16; // providerId GUID
  view.setUint32(off, 300, true); off += 4;       // threadId
  view.setUint32(off, 400, true); off += 4;       // processId
  buf[off] = 0xBB; // user data

  const reader = new BinaryReader(buf);
  const { tryParseWinTraceRecord } = require('../src/records');
  const record = tryParseWinTraceRecord(reader);
  assert(record !== null, 'WinTraceRecord parsed');
  assertEqual(record.recordType, 'WinTraceRecord', 'WinTrace record type');
  assertEqual(record.eventId, 42, 'WinTrace eventId');
  assertEqual(record.threadId, 300, 'WinTrace threadId');
  assertEqual(record.processId, 400, 'WinTrace processId');
  assertEqual(record.userData.length, userDataLen, 'WinTrace userData size');
}

{
  // TraceRecord
  const headerSize = 4 + 4 + 4 + 4 + 8 + 16 + 8; // marker + class + tid + pid + ts + guid + proctime = 48
  const totalSize = headerSize;
  const buf = new Uint8Array(totalSize + 8);
  const view = new DataView(buf.buffer);
  let off = 0;
  view.setUint16(off, totalSize, true); off += 2; // version = total size
  buf[off++] = 0x0A; // TRACE_HEADER_FULL32
  buf[off++] = 0xC0;
  // TraceClass: type(1) + level(1) + version(2)
  buf[off++] = 5;  // type
  buf[off++] = 3;  // level
  view.setUint16(off, 1, true); off += 2; // version
  view.setUint32(off, 500, true); off += 4; // threadId
  view.setUint32(off, 600, true); off += 4; // processId
  view.setBigUint64(off, 88888n, true); off += 8; // timestamp

  const reader = new BinaryReader(buf);
  const { tryParseTraceRecord } = require('../src/records');
  const record = tryParseTraceRecord(reader);
  assert(record !== null, 'TraceRecord parsed');
  assertEqual(record.recordType, 'TraceRecord', 'Trace record type');
  assertEqual(record.threadId, 500, 'Trace threadId');
  assertEqual(record.processId, 600, 'Trace processId');
  assertEqual(record.traceClass.type, 5, 'Trace class type');
  assertEqual(record.traceClass.level, 3, 'Trace class level');
}

// ============================================================
// Invalid marker rejection tests
// ============================================================
console.log('\n=== Invalid marker tests ===');

{
  // Bad flags byte (not 0xC0) should return null
  const buf = new Uint8Array([0x00, 0x00, 0x12, 0x00]); // flags = 0x00
  const reader = new BinaryReader(buf);
  const result = tryParseEventRecord(reader);
  assertEqual(result, null, 'rejects bad marker flags');
}

{
  // Bad WinTrace marker (not 0x9000) should return null
  const buf = new Uint8Array(40);
  const view = new DataView(buf.buffer);
  view.setUint16(0, 32, true);
  view.setUint16(2, 0x1234, true); // wrong marker
  const reader = new BinaryReader(buf);
  const { tryParseWinTraceRecord } = require('../src/records');
  const result = tryParseWinTraceRecord(reader);
  assertEqual(result, null, 'rejects bad WinTrace marker');
}

// ============================================================
// Timestamp sort order test
// ============================================================
console.log('\n=== Timestamp sorting tests ===');

{
  // Build two synthetic EventRecords with out-of-order timestamps
  // and verify parseEtlFile sorts them
  const { parseChunkPayload } = require('../src/records');

  function buildEventRecordBytes(timestamp, eventId) {
    const totalSize = 80;
    const buf = new Uint8Array(totalSize);
    const view = new DataView(buf.buffer);
    let off = 0;
    view.setUint16(off, totalSize, true); off += 2;
    buf[off++] = 0x12; // EVENT_HEADER_EVENT32
    buf[off++] = 0xC0;
    view.setUint16(off, 0, true); off += 2; // flags
    view.setUint16(off, 0, true); off += 2; // eventProperty
    view.setUint32(off, 0, true); off += 4; // threadId
    view.setUint32(off, 0, true); off += 4; // processId
    view.setBigUint64(off, BigInt(timestamp), true); off += 8; // timestamp
    off += 16; // providerId
    view.setUint16(off, eventId, true); off += 2; // event Id
    return buf;
  }

  // Event with later timestamp first, earlier second
  const ev1 = buildEventRecordBytes(200, 2);
  const ev2 = buildEventRecordBytes(100, 1);
  const payload = new Uint8Array(ev1.length + ev2.length);
  payload.set(ev1, 0);
  payload.set(ev2, ev1.length);

  const records = parseChunkPayload(payload);
  // Before sorting: first record has timestamp 200
  assertEqual(records[0].timestamp, 200n, 'unsorted: first has ts 200');
  assertEqual(records[1].timestamp, 100n, 'unsorted: second has ts 100');

  // Simulate sort like parseEtlFile does
  records.sort((a, b) => {
    const ta = a.timestamp ?? 0n;
    const tb = b.timestamp ?? 0n;
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
  assertEqual(records[0].timestamp, 100n, 'sorted: first has ts 100');
  assertEqual(records[1].timestamp, 200n, 'sorted: second has ts 200');
}

// ============================================================
// Multi-field TraceLogging event test
// ============================================================
console.log('\n=== Multi-field TraceLogging test ===');

{
  // Build metadata with 3 fields: ANSISTRING + UINT32 + BOOL32
  const prov = new TextEncoder().encode('Multi');
  const f1 = new TextEncoder().encode('Name');
  const f2 = new TextEncoder().encode('Count');
  const f3 = new TextEncoder().encode('Active');

  const size = 2 + 1 + prov.length + 1 +
    f1.length + 1 + 1 +
    f2.length + 1 + 1 +
    f3.length + 1 + 1;
  const metaBuf = new Uint8Array(size);
  const metaView = new DataView(metaBuf.buffer);
  let off = 0;
  metaView.setUint16(off, size, true); off += 2;
  metaBuf[off++] = 0x00;
  metaBuf.set(prov, off); off += prov.length; metaBuf[off++] = 0x00;
  metaBuf.set(f1, off); off += f1.length; metaBuf[off++] = 0x00;
  metaBuf[off++] = TagIn.ANSISTRING;
  metaBuf.set(f2, off); off += f2.length; metaBuf[off++] = 0x00;
  metaBuf[off++] = TagIn.UINT32;
  metaBuf.set(f3, off); off += f3.length; metaBuf[off++] = 0x00;
  metaBuf[off++] = TagIn.BOOL32;

  // User data: "abc\0" + uint32(99) + bool32(1)
  const userData = new Uint8Array(4 + 4 + 4);
  userData[0] = 0x61; userData[1] = 0x62; userData[2] = 0x63; userData[3] = 0x00;
  new DataView(userData.buffer).setUint32(4, 99, true);
  new DataView(userData.buffer).setInt32(8, 1, true);

  const result = parseTraceLoggingEvent(makeTlRecord(metaBuf, userData));
  assertEqual(result.name, 'Multi', 'multi-field provider name');
  assertEqual(result.fields['Name'], 'abc', 'multi-field string');
  assertEqual(result.fields['Count'], 99, 'multi-field uint32');
  assertEqual(result.fields['Active'], true, 'multi-field bool');
}

// ============================================================
// Summary
// ============================================================
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
