import { readFile, writeFile } from 'node:fs/promises';
import {
  Document,
  isScalar,
  parseDocument,
  visit,
  type YAMLParseError,
} from 'yaml';

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
  | 'invalid-name'
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

function parserMessage(error: Pick<YAMLParseError, 'message'>): string {
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
    intAsBigInt: true,
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
  for (const warning of document.warnings) {
    return {
      ok: false,
      diagnostic: {
        path,
        code: malformedCode(kind),
        message: parserMessage(warning),
      },
    };
  }
  if (!hasOnlyStringKeys(document)) {
    return {
      ok: false,
      diagnostic: {
        path,
        code: malformedCode(kind),
        message: 'YAML mapping keys must be strings',
      },
    };
  }
  if (!hasOnlySupportedTags(document)) {
    return {
      ok: false,
      diagnostic: {
        path,
        code: malformedCode(kind),
        message: 'YAML front matter contains an unsupported tag',
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
  if (metadata === null && document.contents === null) metadata = {};
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
  if (!isSupportedValue(metadata, new WeakSet())) {
    return {
      ok: false,
      diagnostic: {
        path,
        code: malformedCode(kind),
        message: 'YAML front matter contains an unsupported value',
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
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOnlyStringKeys(
  document: ReturnType<typeof parseDocument>
): boolean {
  let valid = true;
  visit(document, {
    Pair: (_key, pair) => {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
        valid = false;
        return visit.BREAK;
      }
    },
  });
  return valid;
}

const SUPPORTED_TAGS = new Set([
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:seq',
  'tag:yaml.org,2002:str',
]);

function hasOnlySupportedTags(
  document: ReturnType<typeof parseDocument>
): boolean {
  let valid = true;
  visit(document, {
    Node: (_key, node) => {
      if (
        'tag' in node &&
        node.tag !== undefined &&
        !SUPPORTED_TAGS.has(node.tag)
      ) {
        valid = false;
        return visit.BREAK;
      }
    },
  });
  return valid;
}

function isSupportedValue(value: unknown, ancestors: WeakSet<object>): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'number'
  ) {
    return true;
  }
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype) return false;

  const keys = Reflect.ownKeys(value);
  if (
    array &&
    (keys.length !== value.length + 1 ||
      keys.some((key, index) =>
        index < value.length ? key !== String(index) : key !== 'length'
      ))
  ) {
    return false;
  }

  ancestors.add(value);
  const valid = keys.every((key) => {
    if (key === 'length' && array) return true;
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor?.enumerable === true &&
      'value' in descriptor &&
      isSupportedValue(descriptor.value, ancestors)
    );
  });
  ancestors.delete(value);
  return valid;
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
    if (
      Object.getPrototypeOf(document.metadata) !== Object.prototype ||
      !isSupportedValue(document.metadata, new WeakSet())
    ) {
      return serializationFailure(
        path,
        'YAML front matter contains an unsupported value'
      );
    }

    const yamlDocument = new Document(document.metadata);
    visit(yamlDocument, {
      Scalar: (_key, scalar) => {
        if (
          typeof scalar.value === 'number' &&
          Number.isInteger(scalar.value)
        ) {
          scalar.minFractionDigits = 1;
        }
      },
    });
    const yaml = yamlDocument.toString({ lineWidth: 0, nullStr: '' });
    const body = document.body.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    return { ok: true, value: `---\n${yaml}---\n${body}` };
  } catch (error) {
    return serializationFailure(path, errorMessage(error));
  }
}

function serializationFailure<T>(path: string, message: string): Outcome<T> {
  return {
    ok: false,
    diagnostic: { path, code: 'serialization-error', message },
  };
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
