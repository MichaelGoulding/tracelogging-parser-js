/**
 * etl-js: TraceLogging ETL file parser for JavaScript/browser.
 *
 * Pure JavaScript, zero dependencies. Works in browsers and Node.js.
 *
 * Usage:
 *   const { parseEtlFile, parseTraceLoggingEvents } = require('etl-js');
 *
 *   // Node.js
 *   const fs = require('fs');
 *   const buf = fs.readFileSync('trace.etl');
 *   const { events } = parseEtlFile(buf);
 *
 *   // Browser
 *   const buf = await file.arrayBuffer();
 *   const { events } = parseEtlFile(buf);
 */

const { parseEtlFile, parseTraceLoggingEvents, parseChunks } = require('./src/etl-parser');
const { parseTraceLoggingEvent, parseTraceLoggingMetadata, TagIn } = require('./src/tracelogging');
const { BinaryReader } = require('./src/binary-reader');
const errors = require('./src/errors');

module.exports = {
  // Main API
  parseEtlFile,
  parseTraceLoggingEvents,

  // Lower-level API
  parseChunks,
  parseTraceLoggingEvent,
  parseTraceLoggingMetadata,
  BinaryReader,
  TagIn,

  // Errors
  ...errors,
};
