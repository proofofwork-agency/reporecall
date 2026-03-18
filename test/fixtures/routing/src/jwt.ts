export function decode(token: string): any {
  return token ? { sub: "user" } : null;
}
