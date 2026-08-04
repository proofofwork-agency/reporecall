export const BUSINESS_QUERY_STOP_TERMS = new Set([
  "which", "what", "where", "when", "does", "this", "that", "there", "with", "from",
  "file", "files", "code", "source", "module", "modules", "class", "classes", "function", "functions",
  "implement", "implements", "implemented", "implementation", "using", "used", "show", "list", "find",
  "trace", "explain", "work", "works", "product", "area", "areas", "capability", "capabilities",
]);

export const PRODUCT_AREA_GENERIC_TERMS = new Set([
  ...BUSINESS_QUERY_STOP_TERMS,
  "account", "accounts", "action", "actions", "active", "admin", "analytics", "app", "apps",
  "asset", "assets", "background", "bucket", "callback", "channel", "client", "clients",
  "component", "components", "credential", "customer", "customers", "dashboard", "data",
  "edge", "email", "event", "events", "external", "file", "files", "filter", "filters",
  "flow", "flows", "general", "identity", "image", "images", "import", "imports", "inbound",
  "info", "input", "inputs", "integration", "job", "jobs", "login", "media", "message",
  "messages", "object", "operator", "output", "outputs", "page", "pages", "payment",
  "platform", "pricing", "prompt", "protected", "queue", "query", "record", "records",
  "render", "report", "reports", "request", "requests", "response", "result", "results",
  "route", "search", "service", "session", "sessions", "status", "storage", "subscription",
  "surface", "system", "user", "users", "workflow", "workflows",
]);

export function tokenize(value: string): Set<string> {
  const expanded = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
  const tokens = expanded
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length >= 3 || /^[A-Z0-9]{2,}$/.test(token))
    .map((token) => token.toLowerCase());
  return new Set(tokens);
}
