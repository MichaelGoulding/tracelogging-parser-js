/**
 * Integration test: parse a real ETL file and print summary + sample events.
 *
 * Usage: node test/test-real-etl.js <path-to-etl-file>
 */
const fs = require('fs');
const { parseEtlFile } = require('../index');

const filePath = process.argv[2] || 'tracelogs_sample.etl';

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const buf = fs.readFileSync(filePath);
console.log(`File: ${filePath} (${buf.length} bytes)\n`);

const errors = [];
const { header, events } = parseEtlFile(buf, {
  onError: (e, chunkIdx) => errors.push({ chunk: chunkIdx, message: e.message }),
});

// Serialize BigInts as strings for JSON output
const replacer = (k, v) => (typeof v === 'bigint' ? v.toString() : v);

console.log('=== File Header ===');
console.log(JSON.stringify(header, replacer, 2));

console.log(`\n=== Summary ===`);
console.log(`Total events: ${events.length}`);

const counts = {};
for (const e of events) {
  counts[e.recordType] = (counts[e.recordType] || 0) + 1;
}
console.log('By record type:', JSON.stringify(counts));

const tlEvents = events.filter(e => e.traceLogging);
console.log(`TraceLogging events: ${tlEvents.length}`);

if (errors.length > 0) {
  console.log(`Parse errors: ${errors.length}`);
}

// Show first 10 TraceLogging events
if (tlEvents.length > 0) {
  console.log(`\n=== First ${Math.min(10, tlEvents.length)} TraceLogging events ===`);
  for (const e of tlEvents.slice(0, 10)) {
    console.log('---');
    console.log(`Provider: ${e.providerId}`);
    console.log(`Event: ${e.traceLogging.name}`);
    console.log(`PID: ${e.processId}, TID: ${e.threadId}, Timestamp: ${e.timestamp}`);
    console.log(`Event ID: ${e.eventDescriptor?.id}, Level: ${e.eventDescriptor?.level}`);
    console.log(`Fields: ${JSON.stringify(e.traceLogging.fields, replacer)}`);
  }
}

// Show first 5 non-TraceLogging EventRecords
const nonTl = events.filter(e => e.recordType === 'EventRecord' && !e.traceLogging);
if (nonTl.length > 0) {
  console.log(`\n=== First ${Math.min(5, nonTl.length)} non-TraceLogging EventRecords ===`);
  for (const e of nonTl.slice(0, 5)) {
    console.log('---');
    console.log(`Provider: ${e.providerId}`);
    console.log(`Event ID: ${e.eventDescriptor?.id}, Version: ${e.eventDescriptor?.version}`);
    console.log(`User data size: ${e.userData.length} bytes`);
  }
}

console.log('\nDone.');
