import { validate } from "./auth";

export function handleRequest(req: any) {
  const result = validate(req.token);
  return { ok: result };
}
