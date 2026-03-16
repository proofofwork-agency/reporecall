/**
 * Validates a user session token
 */
export async function validateSession(token: string): Promise<boolean> {
  if (!token) return false;
  const decoded = decodeToken(token);
  return decoded.exp > Date.now();
}

function decodeToken(token: string): { exp: number; sub: string } {
  const payload = token.split(".")[1];
  return JSON.parse(atob(payload));
}

export interface UserSession {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

export class SessionManager {
  private sessions: Map<string, UserSession> = new Map();

  create(userId: string): UserSession {
    const session: UserSession = {
      id: crypto.randomUUID(),
      userId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): UserSession | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }
}

export enum AuthProvider {
  LOCAL = "local",
  GOOGLE = "google",
  GITHUB = "github",
}

export type AuthConfig = {
  provider: AuthProvider;
  clientId: string;
  clientSecret: string;
};
