import { authenticate, login } from "./auth.js";

export function handleLogin(userId: string): string {
  return JSON.stringify(login(userId));
}

export function handlePrivateRequest(userId: string): string {
  return authenticate(userId) ? "authorized" : "unauthorized";
}
