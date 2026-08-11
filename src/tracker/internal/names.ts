const NORMALIZED_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TICKET_NAME_PATTERN = /^(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export type ParsedTicketName = {
  readonly id: bigint;
  readonly name: string;
  readonly description: string;
};

export function isNormalizedName(value: string): boolean {
  return value.length > 0 && NORMALIZED_NAME_PATTERN.test(value);
}

export function normalizeName(value: string): string | null {
  if (isNormalizedName(value)) return value;

  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{Mark}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length === 0 ? null : normalized;
}

export const normalizeTicketDescription = normalizeName;

export function isAssigneeName(value: string): boolean;
export function isAssigneeName(value: unknown): value is string;
export function isAssigneeName(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

export function parseTicketName(value: string): ParsedTicketName | null {
  const match = TICKET_NAME_PATTERN.exec(value);
  if (match === null) return null;

  const idText = match[1];
  const description = match[2];
  const id = BigInt(idText);
  if (id < 1n) return null;

  return { id, name: value, description };
}

export function isTicketId(value: string): boolean {
  return /^\d+$/.test(value) && BigInt(value) > 0n;
}

export function isTicketReference(value: string): boolean {
  return isQualifiedTicketValue(
    value,
    (ticket) => parseTicketName(ticket) !== null
  );
}

export function isTicketSelector(value: string): boolean {
  return isQualifiedTicketValue(
    value,
    (ticket) => isTicketId(ticket) || parseTicketName(ticket) !== null
  );
}

function isQualifiedTicketValue(
  value: string,
  validateTicket: (ticket: string) => boolean
): boolean {
  const parts = value.split('/');
  if (parts.length === 1) return validateTicket(value);
  if (parts.length !== 2) return false;

  const [projectName, ticket] = parts;
  return isNormalizedName(projectName) && validateTicket(ticket);
}
