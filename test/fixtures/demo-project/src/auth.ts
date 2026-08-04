import { isSessionActive, issueSessionToken, type Session } from "./session.js";

const sessions = new Map<string, Session>();

export function login(userId: string): Session {
  const session = issueSessionToken(userId);
  sessions.set(userId, session);
  return session;
}

export function authenticate(userId: string): boolean {
  const session = sessions.get(userId);
  return session !== undefined && isSessionActive(session);
}
