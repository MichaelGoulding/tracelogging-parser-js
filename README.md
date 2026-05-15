# tracelogging-parser-js

TraceLogging ETL file parser for JavaScript — pure JS, zero dependencies. Works in browsers and Node.js.

Based on the Python [etl-parser](https://github.com/MichaelGoulding/etl-parser) (originally by [Airbus CERT](https://github.com/airbus-cert/etl-parser)).

## What is ETL?

ETL (Event Trace Log) is the binary format used by [ETW (Event Tracing for Windows)](https://docs.microsoft.com/en-us/windows/win32/etw/event-tracing-portal). TraceLogging is a self-describing ETW format where field metadata is embedded directly in each event — no manifest needed.

## Installation

```bash
npm install tracelogging-parser-js
```

Or just copy the files — there are zero dependencies.

## Usage

### Node.js

```js
const fs = require('fs');
const { parseEtlFile, parseTraceLoggingEvents } = require('tracelogging-parser-js');

const buf = fs.readFileSync('trace.etl');
const { header, events } = parseEtlFile(buf);

for (const event of events) {
  if (event.traceLogging) {
    console.log(event.traceLogging.name, event.traceLogging.fields);
  }
}
```

### Browser

```js
const { parseEtlFile } = require('tracelogging-parser-js');

// From a file input
const buf = await file.arrayBuffer();
const { header, events } = parseEtlFile(buf);
```

### Convenience: TraceLogging events only

```js
const { parseTraceLoggingEvents } = require('tracelogging-parser-js');

const events = parseTraceLoggingEvents(buf);
for (const e of events) {
  console.log(`${e.eventName}: ${JSON.stringify(e.fields)}`);
}
```

## API

### `parseEtlFile(buffer, options?)`

Parse an ETL file and return all events.

- **buffer**: `ArrayBuffer | Uint8Array` — raw ETL file contents
- **options.autoParseTraceLogging** (`true`): automatically parse TraceLogging metadata
- **options.onEvent** (`function`): callback for streaming-style processing
- **options.onError** (`function`): callback for parse errors

Returns `{ header, events }`.

### `parseTraceLoggingEvents(buffer, options?)`

Parse an ETL file and return only TraceLogging events as simplified objects with `eventName`, `fields`, `providerId`, `timestamp`, `processId`, `threadId`, and `eventDescriptor`.

## Event structure

Each event object contains:

| Field | Type | Description |
|-------|------|-------------|
| `recordType` | string | `EventRecord`, `TraceRecord`, `SystemTraceRecord`, etc. |
| `providerId` | string | ETW provider GUID |
| `processId` | number | Source process ID |
| `threadId` | number | Source thread ID |
| `timestamp` | BigInt | Event timestamp |
| `eventDescriptor` | object | `{ id, version, channel, level, opcode, task, keyword }` |
| `userData` | Uint8Array | Raw event payload |
| `traceLogging` | object? | `{ name, fields, metadata }` if TraceLogging |

## Supported TraceLogging types

UnicodeString, AnsiString, CountedString, CountedAnsiString, Int8/16/32/64, UInt8/16/32/64, Float, Double, Bool32, HexInt32/64, GUID, FileTime, SystemTime, SID, Binary, CountedBinary, arrays.

## HTML Viewer

A self-contained HTML file (`etl-viewer.html`) lets you open and view ETL files in any browser — no server required. Drag-and-drop an ETL file or use the file picker. Features sortable columns, text/event/level filters, and CSV export.

To build it from source:

```bash
npm run build:viewer
```

This inlines all `src/*.js` modules into `viewer/template.html` and writes `etl-viewer.html`. Edit the template or source files and re-run to regenerate.

## Compressed ETL files

ETL files written with buffer compression (XPRESS / Plain LZ77) are automatically decompressed during parsing. No extra configuration needed.

## Tests

```bash
npm test                                         # unit tests
node test/test-real-etl.js <path-to-etl-file>    # integration test
```

## Credits

- Based on [etl-parser](https://github.com/MichaelGoulding/etl-parser) (Python), originally by [Airbus CERT](https://github.com/airbus-cert/etl-parser)
- ETL format research by [Geoff Chappell](https://www.geoffchappell.com/)

## License

[Apache 2.0](LICENSE)
