import { decode } from "./jwt";

export function validate(token: string): boolean {
  const payload = decode(token);
  return payload !== null;
}
