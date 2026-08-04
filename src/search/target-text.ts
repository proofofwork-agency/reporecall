const CODE_DELIMITER_RE = /[^a-z0-9]+/g;

export function splitIdentifierTokens(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.:/-]+/g, " ")
    .toLowerCase()
    .split(CODE_DELIMITER_RE)
    .filter(Boolean);
}
