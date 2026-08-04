export interface Session {
  userId: string;
  expiresAt: number;
}

export function issueSessionToken(userId: string, now = Date.now()): Session {
  return {
    userId,
    expiresAt: now + 60 * 60 * 1000,
  };
}

export function isSessionActive(session: Session, now = Date.now()): boolean {
  return session.expiresAt > now;
}
