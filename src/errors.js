class EtlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EtlError';
  }
}

class InvalidEtlFileHeader extends EtlError {
  constructor() {
    super('Invalid ETL file header: first chunk is not a valid WmiLogType header');
    this.name = 'InvalidEtlFileHeader';
  }
}

class TraceLoggingMetaDataNotFound extends EtlError {
  constructor() {
    super('Meta data not found for trace logging parser');
    this.name = 'TraceLoggingMetaDataNotFound';
  }
}

class TraceLoggingUnhandledTag extends EtlError {
  constructor(tag) {
    super(`Cannot read tag type ${tag}`);
    this.name = 'TraceLoggingUnhandledTag';
    this.tag = tag;
  }
}

class ParseError extends EtlError {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

module.exports = {
  EtlError,
  InvalidEtlFileHeader,
  TraceLoggingMetaDataNotFound,
  TraceLoggingUnhandledTag,
  ParseError,
};
