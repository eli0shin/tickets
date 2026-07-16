import { readFile, writeFile } from 'node:fs/promises';
import { parseDocument, stringify, type YAMLParseError } from 'yaml';

export type Metadata = Readonly<Record<string, unknown>>;

export type TrackerDocument = {
  readonly metadata: Metadata;
  readonly body: string;
};

export type DocumentKind = 'project' | 'ticket';

export type DocumentDiagnosticCode =
  | 'duplicate-project-key'
  | 'duplicate-ticket-key'
  | 'filesystem-error'
  | 'malformed-project-yaml'
  | 'malformed-ticket-yaml'
  | 'serialization-error';

export type DocumentDiagnostic = {
  readonly path: string;
  readonly code: DocumentDiagnosticCode;
  readonly message: string;
};

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostic: DocumentDiagnostic };

const OPENING_DELIMITER = /^---\r?\n/;
const CLOSING_DELIMITER = /^---(?:\r?\n|$)/m;

function malformedCode(kind: DocumentKind): DocumentDiagnosticCode {
  return kind === 'project'
    ? 'malformed-project-yaml'
    : 'malformed-ticket-yaml';
}

function duplicateCode(kind: DocumentKind): DocumentDiagnosticCode {
  return kind === 'project' ? 'duplicate-project-key' : 'duplicate-ticket-key';
}

function parserMessage(error: YAMLParseError): string {
  return error.message.replace(/\r?\n[\s\S]*$/, '');
}

export function parseTrackerDocument(
  path: string,
  source: string,
  kind: DocumentKind
): Outcome<TrackerDocument> {
  const opening = OPENING_DELIMITER.exec(source);
  const remainder = opening === null ? '' : source.slice(opening[0].length);
  const closing = CLOSING_DELIMITER.exec(remainder);
  if (opening === null || closing === null) {
    return {
      ok: false,
      diagnostic: {
        path,
        code: malformedCode(kind),
        message: 'YAML front matter is missing or not delimited correctly',
      },
    };
  }

  const yamlSource = remainder.slice(0, closing.index);
  const document = parseDocument(yamlSource, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  for (const error of document.errors) {
    const duplicate = error.code === 'DUPLICATE_KEY';
    return {
      ok: false,
      diagnostic: {
        path,
        code: duplicate ? duplicateCode(kind) : malformedCode(kind),
        message: parserMessage(error),
      },
    };
  }

  const conversion = convertToMetadata(
    document.toJS.bind(document),
    path,
    kind
  );
  if (!conversion.ok) return conversion;

  let metadata = conversion.value;
  if (metadata === null && yamlSource.trim() === '') metadata = {};
  if (!isMetadata(metadata)) {
    return {
      ok: false,
      diagnostic: {
        path,
        code: malformedCode(kind),
        message: 'YAML front matter must contain a mapping',
      },
    };
  }

  return {
    ok: true,
    value: {
      metadata,
      body: remainder.slice(closing.index + closing[0].length),
    },
  };
}

export async function readTrackerDocument(
  path: string,
  kind: DocumentKind
): Promise<Outcome<TrackerDocument>> {
  try {
    const source = await readFile(path, 'utf8');
    return parseTrackerDocument(path, source, kind);
  } catch (error) {
    return filesystemFailure(path, error);
  }
}

export async function writeTrackerDocument(
  path: string,
  document: TrackerDocument
): Promise<Outcome<undefined>> {
  const serialization = serializeDocument(path, document);
  if (!serialization.ok) return serialization;

  try {
    await writeFile(path, serialization.value, 'utf8');
    return { ok: true, value: undefined };
  } catch (error) {
    return filesystemFailure(path, error);
  }
}

function isMetadata(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function convertToMetadata(
  convert: () => unknown,
  path: string,
  kind: DocumentKind
): Outcome<unknown> {
  try {
    return { ok: true, value: convert() };
  } catch (error) {
    return malformedFailure(path, kind, error);
  }
}

function serializeDocument(
  path: string,
  document: TrackerDocument
): Outcome<string> {
  try {
    const yaml = stringify(document.metadata, {
      lineWidth: 0,
      nullStr: '',
    });
    const body = document.body.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    return { ok: true, value: `---\n${yaml}---\n${body}` };
  } catch (error) {
    return {
      ok: false,
      diagnostic: {
        path,
        code: 'serialization-error',
        message: errorMessage(error),
      },
    };
  }
}

function malformedFailure<T>(
  path: string,
  kind: DocumentKind,
  error: unknown
): Outcome<T> {
  return {
    ok: false,
    diagnostic: {
      path,
      code: malformedCode(kind),
      message: errorMessage(error),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function filesystemFailure<T>(path: string, error: unknown): Outcome<T> {
  return {
    ok: false,
    diagnostic: {
      path,
      code: 'filesystem-error',
      message: errorMessage(error),
    },
  };
}
