import { link, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  Alias,
  Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Node,
  type Pair,
  type Scalar,
  type YAMLMap,
  type YAMLParseError,
  type YAMLSeq,
} from 'yaml';

export type Metadata = Readonly<Record<string, unknown>>;

export type TrackerDocument = {
  readonly metadata: Metadata;
  readonly body: string;
};

export type DocumentKind = 'project' | 'ticket';

type ParsedMetadata = {
  readonly document: Document;
  readonly original: Metadata;
  readonly root: Metadata;
};

const parsedMetadata = new WeakMap<object, ParsedMetadata>();
const parsedValues = new WeakMap<object, Set<ParsedMetadata>>();
const MAP_ENTRIES: (
  this: Map<unknown, unknown>
) => MapIterator<[unknown, unknown]> = Map.prototype.entries;
const SET_VALUES: (this: Set<unknown>) => SetIterator<unknown> =
  Set.prototype.values;
const DATE_GET_TIME = Date.prototype.getTime;

export type DocumentDiagnosticCode =
  | 'duplicate-project-key'
  | 'duplicate-ticket-key'
  | 'filesystem-error'
  | 'invalid-name'
  | 'invalid-reference'
  | 'invalid-status'
  | 'invalid-ticket-metadata'
  | 'not-found'
  | 'malformed-project-yaml'
  | 'malformed-ticket-yaml'
  | 'resource-exists'
  | 'serialization-error'
  | 'status-not-found';

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
    schema: 'core',
    customTags: ['binary', 'merge', 'omap', 'pairs', 'set', 'timestamp'],
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
  const conversion = convertToMetadata(document, path, kind);
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
  registerParsedMetadata(metadata, {
    document,
    original: snapshotMetadata(metadata),
    root: metadata,
  });
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

export function replaceTrackerMetadata(
  document: TrackerDocument,
  metadata: Metadata
): TrackerDocument {
  const parsed = findParsedMetadata(document.metadata);
  if (parsed !== undefined) registerParsedMetadata(metadata, parsed);
  return { ...document, metadata };
}

export async function writeTrackerDocument(
  path: string,
  document: TrackerDocument
): Promise<Outcome<undefined>> {
  const serialization = serializeDocument(path, document);
  if (!serialization.ok) return serialization;

  try {
    await writeFile(path, serialization.value, { encoding: 'utf8' });
    return { ok: true, value: undefined };
  } catch (error) {
    return filesystemFailure(path, error);
  }
}

export async function writeNewTrackerDocument(
  path: string,
  document: TrackerDocument
): Promise<Outcome<undefined>> {
  const serialization = serializeDocument(path, document);
  if (!serialization.ok) return serialization;

  const temporaryPath = join(dirname(path), `.tickets-${randomUUID()}.tmp`);
  try {
    const file = await open(temporaryPath, 'wx');
    return writeAndPublishNewDocument(
      path,
      temporaryPath,
      file,
      serialization.value
    );
  } catch (error) {
    return filesystemFailure(temporaryPath, error);
  }
}

async function writeAndPublishNewDocument(
  path: string,
  temporaryPath: string,
  file: Awaited<ReturnType<typeof open>>,
  source: string
): Promise<Outcome<undefined>> {
  const write = await writeOwnedTemporary(path, temporaryPath, file, source);
  if (!write.ok) return write;

  const publication = await publishOwnedTemporary(path, temporaryPath);
  if (publication.ok) {
    // Publication succeeded. A cleanup failure must not turn creation into a
    // failed operation whose caller might roll back the published destination.
    await unlinkOwnedTemporary(temporaryPath);
    return { ok: true, value: undefined };
  }

  const cleanup = await unlinkOwnedTemporary(temporaryPath);
  return cleanup.ok ? publication : cleanup;
}

async function writeOwnedTemporary(
  path: string,
  temporaryPath: string,
  file: Awaited<ReturnType<typeof open>>,
  source: string
): Promise<Outcome<undefined>> {
  try {
    await file.writeFile(source, { encoding: 'utf8' });
    await file.close();
    return { ok: true, value: undefined };
  } catch (error) {
    try {
      await file.close();
    } catch {
      // Continue cleanup: this invocation uniquely owns the temporary path.
    }
    const cleanup = await unlinkOwnedTemporary(temporaryPath);
    return cleanup.ok ? filesystemFailure(path, error) : cleanup;
  }
}

async function publishOwnedTemporary(
  path: string,
  temporaryPath: string
): Promise<Outcome<undefined>> {
  try {
    await link(temporaryPath, path);
    return { ok: true, value: undefined };
  } catch (error) {
    if (hasErrorCode(error, new Set(['EEXIST']))) return resourceExists(path);
    return filesystemFailure(path, error);
  }
}

async function unlinkOwnedTemporary(path: string): Promise<Outcome<undefined>> {
  try {
    await unlink(path);
    return { ok: true, value: undefined };
  } catch (error) {
    if (hasErrorCode(error, new Set(['ENOENT']))) {
      return { ok: true, value: undefined };
    }
    return filesystemFailure(path, error);
  }
}

function resourceExists<T>(path: string): Outcome<T> {
  return {
    ok: false,
    diagnostic: {
      path,
      code: 'resource-exists',
      message: `Resource already exists: ${path}`,
    },
  };
}

function isMetadata(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function registerParsedMetadata(
  metadata: Metadata,
  parsed: ParsedMetadata
): void {
  parsedMetadata.set(metadata, parsed);
  visitObjectGraph(metadata, (value) => {
    const contexts = parsedValues.get(value) ?? new Set<ParsedMetadata>();
    contexts.add(parsed);
    parsedValues.set(value, contexts);
  });
}

function findParsedMetadata(metadata: Metadata): ParsedMetadata | undefined {
  const direct = parsedMetadata.get(metadata);
  if (direct !== undefined) return direct;

  const contexts = new Set<ParsedMetadata>();
  visitObjectGraph(metadata, (value) => {
    for (const parsed of parsedValues.get(value) ?? []) contexts.add(parsed);
  });
  if (contexts.size !== 1) return undefined;

  const parsed = contexts.values().next().value;
  if (parsed !== undefined) registerParsedMetadata(metadata, parsed);
  return parsed;
}

function visitObjectGraph(
  root: object,
  visitValue: (value: object) => void
): void {
  const pending: object[] = [root];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined || visited.has(value)) continue;
    visited.add(value);
    visitValue(value);

    if (isExactMap(value)) {
      for (const [key, item] of MAP_ENTRIES.call(value)) {
        if (key !== null && typeof key === 'object') pending.push(key);
        if (item !== null && typeof item === 'object') pending.push(item);
      }
    } else if (isExactSet(value)) {
      for (const item of SET_VALUES.call(value)) {
        if (item !== null && typeof item === 'object') pending.push(item);
      }
    } else {
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const item: unknown =
          descriptor !== undefined && 'value' in descriptor
            ? descriptor.value
            : undefined;
        if (item !== null && typeof item === 'object') pending.push(item);
      }
    }
  }
}

function isExactMap(value: unknown): value is Map<unknown, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Map.prototype
  );
}

function isExactSet(value: unknown): value is Set<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Set.prototype
  );
}

function isExactDate(value: unknown): value is Date {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Date.prototype
  );
}

function isExactBuffer(value: unknown): value is Buffer {
  return (
    Buffer.isBuffer(value) && Object.getPrototypeOf(value) === Buffer.prototype
  );
}

function snapshotMetadata(metadata: Metadata): Metadata {
  const snapshot = snapshotValue(metadata, new WeakMap<object, unknown>());
  if (!isMetadata(snapshot)) throw new Error('Metadata snapshot must be a map');
  return snapshot;
}

function snapshotValue(
  value: unknown,
  snapshots: WeakMap<object, unknown>
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const existing = snapshots.get(value);
  if (existing !== undefined) return existing;

  if (isExactBuffer(value)) {
    const snapshot = Buffer.from(value);
    snapshots.set(value, snapshot);
    return snapshot;
  }
  if (isExactDate(value)) {
    const snapshot = new Date(DATE_GET_TIME.call(value));
    snapshots.set(value, snapshot);
    return snapshot;
  }
  if (Array.isArray(value)) {
    const snapshot: unknown[] = [];
    snapshots.set(value, snapshot);
    snapshot.push(...value.map((item) => snapshotValue(item, snapshots)));
    return snapshot;
  }
  if (isExactMap(value)) {
    const snapshot = new Map<unknown, unknown>();
    snapshots.set(value, snapshot);
    for (const [key, item] of MAP_ENTRIES.call(value)) {
      snapshot.set(
        snapshotValue(key, snapshots),
        snapshotValue(item, snapshots)
      );
    }
    return snapshot;
  }
  if (isExactSet(value)) {
    const snapshot = new Set<unknown>();
    snapshots.set(value, snapshot);
    for (const item of SET_VALUES.call(value)) {
      snapshot.add(snapshotValue(item, snapshots));
    }
    return snapshot;
  }
  if (Object.getPrototypeOf(value) === Object.prototype) {
    const snapshot = Object.fromEntries<unknown>([]);
    snapshots.set(value, snapshot);
    for (const key of Object.keys(value)) {
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: snapshotValue(Reflect.get(value, key), snapshots),
        writable: true,
      });
    }
    return snapshot;
  }
  return value;
}

function convertToMetadata(
  document: ReturnType<typeof parseDocument>,
  path: string,
  kind: DocumentKind
): Outcome<unknown> {
  if (document.contents === null) return { ok: true, value: null };

  try {
    if (!isMap(document.contents)) {
      return { ok: true, value: document.toJS() };
    }

    const mapAsMap = document.contents.items.some(
      (pair) => !isStringKey(pair) || hasNonStringKey(pair.value)
    );
    const converted: unknown = document.toJS({ mapAsMap });
    if (!isExactMap(converted)) return { ok: true, value: converted };
    return materializeMetadata(converted, path, kind);
  } catch (error) {
    return malformedFailure(path, kind, error);
  }
}

function materializeMetadata(
  root: Map<unknown, unknown>,
  path: string,
  kind: DocumentKind
): Outcome<Metadata> {
  if ([...MAP_ENTRIES.call(root)].some(([key]) => typeof key !== 'string')) {
    return {
      ok: false,
      diagnostic: {
        path,
        code: malformedCode(kind),
        message: 'YAML front matter keys must be strings',
      },
    };
  }

  const metadata = Object.fromEntries<unknown>([]);
  const transformed = new WeakMap<object, unknown>([[root, metadata]]);
  for (const [key, value] of MAP_ENTRIES.call(root)) {
    if (typeof key === 'string') {
      Object.defineProperty(metadata, key, {
        configurable: true,
        enumerable: true,
        value: remapGraph(value, transformed),
        writable: true,
      });
    }
  }
  return { ok: true, value: metadata };
}

function remapGraph(
  value: unknown,
  transformed: WeakMap<object, unknown>
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const existing = transformed.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    transformed.set(value, result);
    result.push(...value.map((item) => remapGraph(item, transformed)));
    return result;
  }
  if (isExactMap(value)) {
    const result = new Map<unknown, unknown>();
    transformed.set(value, result);
    for (const [key, item] of MAP_ENTRIES.call(value)) {
      result.set(remapGraph(key, transformed), remapGraph(item, transformed));
    }
    return result;
  }
  if (isExactSet(value)) {
    const result = new Set<unknown>();
    transformed.set(value, result);
    for (const item of SET_VALUES.call(value)) {
      result.add(remapGraph(item, transformed));
    }
    return result;
  }
  return value;
}

function isStringKey(pair: Pair): pair is Pair<Scalar<string>> {
  return isScalar(pair.key) && typeof pair.key.value === 'string';
}

function hasNonStringKey(node: unknown): boolean {
  if (!isNode(node)) return false;
  let found = false;
  visit(node, {
    Pair: (_key, pair) => {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
        found = true;
        return visit.BREAK;
      }
    },
  });
  return found;
}

function serializeDocument(
  path: string,
  document: TrackerDocument
): Outcome<string> {
  try {
    if (
      Object.getPrototypeOf(document.metadata) !== Object.prototype ||
      !hasOnlyYamlMetadataProperties(document.metadata, new WeakSet())
    ) {
      return serializationFailure(
        path,
        'YAML front matter contains an unsupported value'
      );
    }

    const parsed = findParsedMetadata(document.metadata);
    if (
      parsed === undefined &&
      !isSerializableValue(document.metadata, new WeakSet())
    ) {
      return serializationFailure(
        path,
        'YAML front matter contains an unsupported value'
      );
    }
    const yamlDocument =
      parsed === undefined
        ? new Document(document.metadata)
        : reconcileMetadata(parsed, document.metadata);
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

function hasOnlyYamlMetadataProperties(
  value: unknown,
  visited: WeakSet<object>
): boolean {
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
  if (visited.has(value)) return true;
  visited.add(value);

  if (isExactBuffer(value)) {
    return hasOnlyIndexedDataProperties(value);
  }
  if (isExactDate(value)) return Reflect.ownKeys(value).length === 0;
  if (isExactMap(value)) {
    return (
      Reflect.ownKeys(value).length === 0 &&
      [...MAP_ENTRIES.call(value)].every(
        ([key, item]) =>
          hasOnlyYamlMetadataProperties(key, visited) &&
          hasOnlyYamlMetadataProperties(item, visited)
      )
    );
  }
  if (isExactSet(value)) {
    return (
      Reflect.ownKeys(value).length === 0 &&
      [...SET_VALUES.call(value)].every((item) =>
        hasOnlyYamlMetadataProperties(item, visited)
      )
    );
  }

  const array = Array.isArray(value);
  if (
    (array && Object.getPrototypeOf(value) !== Array.prototype) ||
    (!array && Object.getPrototypeOf(value) !== Object.prototype)
  ) {
    return false;
  }
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
  return keys.every((key) => {
    if (array && key === 'length') return true;
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor?.enumerable === true &&
      'value' in descriptor &&
      hasOnlyYamlMetadataProperties(descriptor.value, visited)
    );
  });
}

function hasOnlyIndexedDataProperties(value: Buffer): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === value.length &&
    keys.every((key, index) => {
      if (key !== String(index)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && 'value' in descriptor;
    })
  );
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function isSerializableValue(
  value: unknown,
  ancestors: WeakSet<object>
): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'number'
  ) {
    return true;
  }
  if (typeof value !== 'object' || ancestors.has(value)) return false;

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
      isSerializableValue(descriptor.value, ancestors)
    );
  });
  ancestors.delete(value);
  return valid;
}

function metadataValuesEqual(left: unknown, right: unknown): boolean {
  return graphValuesEqual(
    left,
    right,
    new WeakMap<object, object>(),
    new WeakMap<object, object>()
  );
}

function graphValuesEqual(
  left: unknown,
  right: unknown,
  leftToRight: WeakMap<object, object>,
  rightToLeft: WeakMap<object, object>
): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }

  const knownRight = leftToRight.get(left);
  const knownLeft = rightToLeft.get(right);
  if (knownRight !== undefined || knownLeft !== undefined) {
    return knownRight === right && knownLeft === left;
  }
  leftToRight.set(left, right);
  rightToLeft.set(right, left);

  if (isExactBuffer(left) || isExactBuffer(right)) {
    return (
      isExactBuffer(left) && isExactBuffer(right) && buffersEqual(left, right)
    );
  }
  if (isExactDate(left) || isExactDate(right)) {
    return (
      isExactDate(left) &&
      isExactDate(right) &&
      DATE_GET_TIME.call(left) === DATE_GET_TIME.call(right)
    );
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) =>
        graphValuesEqual(item, right[index], leftToRight, rightToLeft)
      )
    );
  }
  if (isExactMap(left) || isExactMap(right)) {
    if (!isExactMap(left) || !isExactMap(right)) return false;
    const leftEntries = [...MAP_ENTRIES.call(left)];
    const rightEntries = [...MAP_ENTRIES.call(right)];
    return (
      leftEntries.length === rightEntries.length &&
      leftEntries.every(([key, value], index) => {
        const rightEntry = rightEntries[index];
        return (
          graphValuesEqual(key, rightEntry[0], leftToRight, rightToLeft) &&
          graphValuesEqual(value, rightEntry[1], leftToRight, rightToLeft)
        );
      })
    );
  }
  if (isExactSet(left) || isExactSet(right)) {
    if (!isExactSet(left) || !isExactSet(right)) return false;
    const leftItems = [...SET_VALUES.call(left)];
    const rightItems = [...SET_VALUES.call(right)];
    return (
      leftItems.length === rightItems.length &&
      leftItems.every((item, index) =>
        graphValuesEqual(item, rightItems[index], leftToRight, rightToLeft)
      )
    );
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    Object.getPrototypeOf(left) === Object.getPrototypeOf(right) &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        graphValuesEqual(
          Reflect.get(left, key),
          Reflect.get(right, key),
          leftToRight,
          rightToLeft
        )
    )
  );
}

function reconcileMetadata(
  parsed: ParsedMetadata,
  metadata: Metadata
): Document<Node, boolean> {
  if (metadata !== parsed.root && hasAliasToDocumentRoot(parsed.document)) {
    throw new Error('Cannot safely detach an alias to the YAML document root');
  }
  const document = parsed.document.clone();
  if (!isMap(document.contents)) return new Document(metadata);

  const map: YAMLMap = document.contents;
  const replacedKeys = new Set([
    ...Object.keys(parsed.original).filter(
      (key) =>
        !Object.hasOwn(metadata, key) ||
        !metadataValuesEqual(parsed.original[key], metadata[key])
    ),
    ...Object.keys(metadata).filter(
      (key) => !Object.hasOwn(parsed.original, key)
    ),
  ]);
  if (changedFieldsShareObjects(metadata, replacedKeys)) {
    throw new Error('Cannot safely serialize modified aliased YAML fields');
  }

  const replacedAliases = aliasesWithinFields(map, replacedKeys);
  for (const key of replacedKeys) {
    preserveAliasesOfReplacedValue(document, map, key, replacedAliases);
  }

  for (const key of Object.keys(parsed.original)) {
    if (!Object.hasOwn(metadata, key)) {
      if (!hasExplicitKey(map, key)) {
        throw new Error(`Cannot remove YAML merge-provided field: ${key}`);
      }
      map.delete(key);
    }
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (
      !Object.hasOwn(parsed.original, key) ||
      !metadataValuesEqual(parsed.original[key], value)
    ) {
      setMetadataValue(document, map, key, value);
    }
  }
  return document;
}

function setMetadataValue(
  document: Document<Node, boolean>,
  map: YAMLMap,
  key: string,
  value: unknown
): void {
  const pair = map.items.find(
    (item) => isScalar(item.key) && item.key.value === key
  );
  const source = pair?.value;
  const tag =
    isNode(source) && 'tag' in source && typeof source.tag === 'string'
      ? source.tag
      : undefined;
  if (tag !== undefined && !isCompatibleTaggedValue(tag, value)) {
    throw new Error(`Cannot safely change tagged YAML field: ${key}`);
  }
  if (
    containsMap(value, new WeakSet<object>()) &&
    tag !== 'tag:yaml.org,2002:omap' &&
    tag !== 'tag:yaml.org,2002:pairs'
  ) {
    throw new Error(
      `Cannot safely serialize modified YAML mappings for field: ${key}`
    );
  }

  const serializedValue =
    tag === 'tag:yaml.org,2002:pairs' ? serializePairs(value, key) : value;
  const replacement =
    tag === undefined
      ? document.createNode(serializedValue)
      : document.createNode(serializedValue, { tag });
  map.set(key, replacement);
}

function isCompatibleTaggedValue(tag: string, value: unknown): boolean {
  switch (tag) {
    case 'tag:yaml.org,2002:binary':
      return isExactBuffer(value);
    case 'tag:yaml.org,2002:bool':
      return typeof value === 'boolean';
    case 'tag:yaml.org,2002:float':
      return typeof value === 'number';
    case 'tag:yaml.org,2002:int':
      return typeof value === 'bigint';
    case 'tag:yaml.org,2002:map':
      return isExactMap(value) || isPlainObject(value);
    case 'tag:yaml.org,2002:null':
      return value === null;
    case 'tag:yaml.org,2002:omap':
      return isExactMap(value);
    case 'tag:yaml.org,2002:pairs':
      return (
        Array.isArray(value) &&
        Object.getPrototypeOf(value) === Array.prototype &&
        value.every(isCompatiblePair)
      );
    case 'tag:yaml.org,2002:seq':
      return (
        Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
      );
    case 'tag:yaml.org,2002:set':
      return isExactSet(value);
    case 'tag:yaml.org,2002:str':
      return typeof value === 'string';
    case 'tag:yaml.org,2002:timestamp':
      return isExactDate(value);
    default:
      return false;
  }
}

function isCompatiblePair(value: unknown): boolean {
  if (isExactMap(value)) {
    return [...MAP_ENTRIES.call(value)].length === 1;
  }
  return isPlainObject(value) && Object.keys(value).length === 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function serializePairs(value: unknown, field: string): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((pair: unknown) => {
    if (!isExactMap(pair)) return pair;
    if ([...MAP_ENTRIES.call(pair)].some(([key]) => typeof key !== 'string')) {
      throw new Error(
        `Cannot safely serialize modified YAML pairs for field: ${field}`
      );
    }
    const serialized = Object.fromEntries<unknown>([]);
    for (const [key, item] of MAP_ENTRIES.call(pair)) {
      if (typeof key === 'string') {
        Object.defineProperty(serialized, key, {
          configurable: true,
          enumerable: true,
          value: item,
          writable: true,
        });
      }
    }
    return serialized;
  });
}

function containsMap(value: unknown, visited: WeakSet<object>): boolean {
  if (value === null || typeof value !== 'object' || visited.has(value)) {
    return false;
  }
  if (isExactMap(value)) return true;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsMap(item, visited));
  }
  if (isExactSet(value)) {
    return [...SET_VALUES.call(value)].some((item) =>
      containsMap(item, visited)
    );
  }
  return Object.keys(value).some((key) =>
    containsMap(Reflect.get(value, key), visited)
  );
}

function hasAliasToDocumentRoot(document: Document): boolean {
  if (!isMap(document.contents)) return false;
  let found = false;
  visit(document, {
    Alias: (_visitKey, alias) => {
      if (alias.resolve(document) === document.contents) found = true;
    },
  });
  return found;
}

function changedFieldsShareObjects(
  metadata: Metadata,
  changedFields: ReadonlySet<string>
): boolean {
  const owners = new WeakMap<object, string>();
  for (const field of Object.keys(metadata)) {
    const value = metadata[field];
    if (value === null || typeof value !== 'object') continue;
    const objects = new Set<object>();
    visitObjectGraph(value, (object) => {
      if (!objects.has(object)) objects.add(object);
    });
    for (const object of objects) {
      const owner = owners.get(object);
      if (
        owner !== undefined &&
        owner !== field &&
        (changedFields.has(owner) || changedFields.has(field))
      ) {
        return true;
      }
      owners.set(object, field);
    }
  }
  return false;
}

function hasExplicitKey(map: YAMLMap, key: string): boolean {
  return map.items.some((item) => isScalar(item.key) && item.key.value === key);
}

function aliasesWithinFields(
  map: YAMLMap,
  fields: ReadonlySet<string>
): ReadonlySet<Alias> {
  const aliases = new Set<Alias>();
  for (const pair of map.items) {
    if (
      !isScalar(pair.key) ||
      typeof pair.key.value !== 'string' ||
      !fields.has(pair.key.value) ||
      !isNode(pair.value)
    ) {
      continue;
    }
    visit(pair.value, {
      Alias: (_visitKey, alias) => {
        aliases.add(alias);
      },
    });
  }
  return aliases;
}

function preserveAliasesOfReplacedValue(
  document: Document<Node, boolean>,
  map: YAMLMap,
  key: string,
  replacedAliases: ReadonlySet<Alias>
): void {
  const pair = map.items.find(
    (item) => isScalar(item.key) && item.key.value === key
  );
  if (!isNode(pair?.value)) return;

  const plans = anchoredValuesIn(pair.value).flatMap((value) => {
    const aliases = externalAliasesFor(document, value, replacedAliases);
    return aliases.length === 0 ? [] : [{ value, aliases }];
  });
  if (
    plansShareAnchoredSubtree(plans) ||
    plans.some(
      ({ value }) =>
        containsAlias(value) &&
        (key !== 'Blocked-By' ||
          hasExplicitTag(value) ||
          !aliasesResolveToScalars(document, value))
    )
  ) {
    throw new Error('Cannot safely preserve nested YAML alias relationships');
  }
  for (const { value, aliases } of plans) {
    preserveExternalAliases(document, value, aliases);
  }
}

function anchoredValuesIn(node: Node): (Scalar | YAMLMap | YAMLSeq)[] {
  const anchoredValues: (Scalar | YAMLMap | YAMLSeq)[] = [];
  visit(node, {
    Node: (_visitKey, value) => {
      if (
        (isScalar(value) || isMap(value) || isSeq(value)) &&
        value.anchor !== undefined
      ) {
        anchoredValues.push(value);
      }
    },
  });
  return anchoredValues;
}

function externalAliasesFor(
  document: Document<Node, boolean>,
  value: Scalar | YAMLMap | YAMLSeq,
  replacedAliases: ReadonlySet<Alias>
): Alias[] {
  const aliases: Alias[] = [];
  visit(document, {
    Alias: (_visitKey, alias) => {
      if (!replacedAliases.has(alias) && alias.resolve(document) === value) {
        aliases.push(alias);
      }
    },
  });
  return aliases;
}

function plansShareAnchoredSubtree(
  plans: readonly {
    readonly value: Scalar | YAMLMap | YAMLSeq;
    readonly aliases: readonly Alias[];
  }[]
): boolean {
  const plannedValues = new Set(plans.map(({ value }) => value));
  return plans.some(({ value }) =>
    anchoredValuesIn(value).some(
      (nested) => nested !== value && plannedValues.has(nested)
    )
  );
}

function hasExplicitTag(value: Scalar | YAMLMap | YAMLSeq): boolean {
  return 'tag' in value && typeof value.tag === 'string';
}

function aliasesResolveToScalars(
  document: Document<Node, boolean>,
  value: Scalar | YAMLMap | YAMLSeq
): boolean {
  let valid = true;
  visit(value, {
    Alias: (_visitKey, alias) => {
      if (!isScalar(alias.resolve(document))) {
        valid = false;
        return visit.BREAK;
      }
    },
  });
  return valid;
}

function containsAlias(value: Scalar | YAMLMap | YAMLSeq): boolean {
  let found = false;
  visit(value, {
    Alias: () => {
      found = true;
      return visit.BREAK;
    },
  });
  return found;
}

function preserveExternalAliases(
  document: Document<Node, boolean>,
  value: Scalar | YAMLMap | YAMLSeq,
  aliases: readonly Alias[]
): void {
  if (value.anchor === undefined) return;
  const source = value.anchor;
  const anchors = new Set<string>();
  visit(document, {
    Node: (_visitKey, node) => {
      if ('anchor' in node && typeof node.anchor === 'string') {
        anchors.add(node.anchor);
      }
    },
  });
  const anchor = uniqueAnchor(`${source}-preserved`, anchors);
  const preserved = containsAlias(value)
    ? document.createNode(value.toJS(document))
    : value.clone();
  if (!isScalar(preserved) && !isMap(preserved) && !isSeq(preserved)) return;
  preserved.anchor = anchor;
  let first = true;
  visit(document, {
    Alias: (_visitKey, alias) => {
      if (!aliases.includes(alias)) return;
      if (first) {
        first = false;
        return preserved;
      }
      return new Alias(anchor);
    },
  });
}

function uniqueAnchor(candidate: string, anchors: ReadonlySet<string>): string {
  let anchor = candidate;
  let suffix = 2;
  while (anchors.has(anchor)) {
    anchor = `${candidate}-${suffix}`;
    suffix += 1;
  }
  return anchor;
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

function hasErrorCode(error: unknown, codes: ReadonlySet<string>): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.has(error.code)
  );
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
