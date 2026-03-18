import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export interface GeneratedCodebase {
  name: string;
  fileCount: number;
  approxLoc: number;
  dir: string;
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = join(dir, relPath);
  const parent = full.substring(0, full.lastIndexOf("/"));
  mkdirSync(parent, { recursive: true });
  writeFileSync(full, content, "utf-8");
}

// ─── Small Codebase: Auth Service (~5 files, ~200 LOC) ───

export function generateSmallCodebase(dir: string): GeneratedCodebase {
  writeFile(
    dir,
    "src/config.ts",
    `export interface AuthConfig {
  jwtSecret: string;
  tokenExpiryMs: number;
  sessionTimeoutMs: number;
  maxActiveSessions: number;
}

export const defaultConfig: AuthConfig = {
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret",
  tokenExpiryMs: 3600_000,
  sessionTimeoutMs: 1800_000,
  maxActiveSessions: 5,
};

/** Load configuration from environment, falling back to defaults */
export function loadAuthConfig(): AuthConfig {
  return {
    ...defaultConfig,
    jwtSecret: process.env.JWT_SECRET ?? defaultConfig.jwtSecret,
    tokenExpiryMs: Number(process.env.TOKEN_EXPIRY_MS) || defaultConfig.tokenExpiryMs,
    sessionTimeoutMs: Number(process.env.SESSION_TIMEOUT_MS) || defaultConfig.sessionTimeoutMs,
    maxActiveSessions: Number(process.env.MAX_SESSIONS) || defaultConfig.maxActiveSessions,
  };
}
`
  );

  writeFile(
    dir,
    "src/token.ts",
    `import { loadAuthConfig } from "./config.js";

export interface TokenPayload {
  userId: string;
  email: string;
  roles: string[];
  issuedAt: number;
  expiresAt: number;
}

/** Generate a signed JWT token for the given user */
export function generateToken(userId: string, email: string, roles: string[]): string {
  const config = loadAuthConfig();
  const now = Date.now();
  const payload: TokenPayload = {
    userId,
    email,
    roles,
    issuedAt: now,
    expiresAt: now + config.tokenExpiryMs,
  };
  // Simplified: in production use proper JWT signing
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/** Validate and decode a JWT token */
export function validateToken(token: string): TokenPayload | null {
  try {
    const payload: TokenPayload = JSON.parse(Buffer.from(token, "base64").toString("utf-8"));
    if (payload.expiresAt < Date.now()) {
      return null; // Token expired
    }
    return payload;
  } catch {
    return null;
  }
}

/** Check whether a token has a specific role */
export function hasRole(token: string, role: string): boolean {
  const payload = validateToken(token);
  return payload?.roles.includes(role) ?? false;
}
`
  );

  writeFile(
    dir,
    "src/session.ts",
    `import { loadAuthConfig } from "./config.js";
import { validateToken, type TokenPayload } from "./token.js";

export interface Session {
  id: string;
  userId: string;
  token: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

/** Create a new session for the given user and token */
export function createSession(userId: string, token: string): Session {
  const config = loadAuthConfig();
  const now = Date.now();

  // Enforce max active sessions
  const userSessions = Array.from(sessions.values()).filter(s => s.userId === userId);
  if (userSessions.length >= config.maxActiveSessions) {
    // Remove oldest session
    const oldest = userSessions.sort((a, b) => a.createdAt - b.createdAt)[0];
    sessions.delete(oldest.id);
  }

  const session: Session = {
    id: \`sess_\${Math.random().toString(36).slice(2)}\`,
    userId,
    token,
    createdAt: now,
    lastAccessedAt: now,
    expiresAt: now + config.sessionTimeoutMs,
  };
  sessions.set(session.id, session);
  return session;
}

/** Get a session by ID and refresh its timeout */
export function getSession(sessionId: string): Session | null {
  const session = sessions.get(sessionId);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null; // Session expired
  }

  // Refresh the session timeout
  const config = loadAuthConfig();
  session.lastAccessedAt = Date.now();
  session.expiresAt = Date.now() + config.sessionTimeoutMs;
  return session;
}

/** Destroy a session (logout) */
export function destroySession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

/** Get all active sessions for a user */
export function getUserSessions(userId: string): Session[] {
  return Array.from(sessions.values())
    .filter(s => s.userId === userId && s.expiresAt > Date.now());
}
`
  );

  writeFile(
    dir,
    "src/users.ts",
    `export interface User {
  id: string;
  email: string;
  passwordHash: string;
  roles: string[];
  createdAt: number;
}

const users = new Map<string, User>();

/** Create a new user with the given email and password hash */
export function createUser(email: string, passwordHash: string, roles: string[] = ["user"]): User {
  const user: User = {
    id: \`usr_\${Math.random().toString(36).slice(2)}\`,
    email,
    passwordHash,
    roles,
    createdAt: Date.now(),
  };
  users.set(user.id, user);
  return user;
}

/** Find a user by email address */
export function findUserByEmail(email: string): User | undefined {
  return Array.from(users.values()).find(u => u.email === email);
}

/** Find a user by ID */
export function findUserById(id: string): User | undefined {
  return users.get(id);
}

/** Update a user's roles */
export function updateUserRoles(userId: string, roles: string[]): boolean {
  const user = users.get(userId);
  if (!user) return false;
  user.roles = roles;
  return true;
}

/** Delete a user by ID */
export function deleteUser(userId: string): boolean {
  return users.delete(userId);
}
`
  );

  writeFile(
    dir,
    "src/middleware.ts",
    `import { validateToken, type TokenPayload } from "./token.js";
import { getSession } from "./session.js";

export interface AuthenticatedRequest {
  sessionId: string;
  token: string;
  user: TokenPayload;
}

/** Authentication middleware — validates token and session */
export function authenticateRequest(
  sessionId: string,
  token: string
): AuthenticatedRequest | { error: string; status: number } {
  // Validate the token first
  const payload = validateToken(token);
  if (!payload) {
    return { error: "Invalid or expired token", status: 401 };
  }

  // Check the session
  const session = getSession(sessionId);
  if (!session) {
    return { error: "Session not found or expired", status: 401 };
  }

  // Verify the token matches the session
  if (session.token !== token) {
    return { error: "Token does not match session", status: 403 };
  }

  return { sessionId, token, user: payload };
}

/** Authorization middleware — checks if user has required role */
export function requireRole(
  request: AuthenticatedRequest,
  role: string
): true | { error: string; status: number } {
  if (!request.user.roles.includes(role)) {
    return { error: \`Requires role: \${role}\`, status: 403 };
  }
  return true;
}
`
  );

  return { name: "small", fileCount: 5, approxLoc: 200, dir };
}

// ─── Medium Codebase: E-Commerce API (~25 files, ~1500 LOC) ───

export function generateMediumCodebase(dir: string): GeneratedCodebase {
  // Config
  writeFile(
    dir,
    "src/config.ts",
    `export interface AppConfig {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  stripeSecretKey: string;
  logLevel: "debug" | "info" | "warn" | "error";
  maxPageSize: number;
  defaultCurrency: string;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT) || 3000,
    databaseUrl: process.env.DATABASE_URL ?? "sqlite://shop.db",
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret",
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
    logLevel: (process.env.LOG_LEVEL as AppConfig["logLevel"]) ?? "info",
    maxPageSize: 100,
    defaultCurrency: "USD",
  };
}
`
  );

  // Types
  writeFile(
    dir,
    "src/types/product.ts",
    `export interface Product {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  category: string;
  inventory: number;
  imageUrls: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProductInput {
  name: string;
  description: string;
  priceCents: number;
  category: string;
  inventory: number;
  imageUrls?: string[];
}

export interface ProductSearchFilters {
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  query?: string;
}
`
  );

  writeFile(
    dir,
    "src/types/order.ts",
    `export type OrderStatus = "pending" | "paid" | "shipped" | "delivered" | "cancelled" | "refunded";

export interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  userId: string;
  items: OrderItem[];
  totalCents: number;
  status: OrderStatus;
  shippingAddress: ShippingAddress;
  paymentIntentId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShippingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface CreateOrderInput {
  items: Array<{ productId: string; quantity: number }>;
  shippingAddress: ShippingAddress;
}
`
  );

  writeFile(
    dir,
    "src/types/user.ts",
    `export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: "customer" | "admin";
  createdAt: Date;
}

export interface CreateUserInput {
  email: string;
  password: string;
  name: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
`
  );

  writeFile(
    dir,
    "src/types/cart.ts",
    `export interface CartItem {
  productId: string;
  quantity: number;
  addedAt: Date;
}

export interface Cart {
  userId: string;
  items: CartItem[];
  updatedAt: Date;
}
`
  );

  // Database layer
  writeFile(
    dir,
    "src/database/connection.ts",
    `import { loadConfig } from "../config.js";

export interface DatabaseConnection {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

let connection: DatabaseConnection | null = null;

/** Get or create the database connection singleton */
export async function getDatabase(): Promise<DatabaseConnection> {
  if (connection) return connection;

  const config = loadConfig();
  // Simplified: in production, use actual DB driver
  const store = new Map<string, unknown[]>();

  connection = {
    async query<T>(sql: string, _params?: unknown[]): Promise<T[]> {
      return (store.get(sql) ?? []) as T[];
    },
    async execute(sql: string, params?: unknown[]): Promise<{ changes: number }> {
      const existing = store.get(sql) ?? [];
      existing.push(params);
      store.set(sql, existing);
      return { changes: 1 };
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async close(): Promise<void> {
      connection = null;
    },
  };
  return connection;
}

/** Close the database connection */
export async function closeDatabase(): Promise<void> {
  if (connection) {
    await connection.close();
    connection = null;
  }
}
`
  );

  writeFile(
    dir,
    "src/database/migrations.ts",
    `import { getDatabase } from "./connection.js";

/** Run all pending database migrations */
export async function runMigrations(): Promise<void> {
  const db = await getDatabase();

  await db.execute(\`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'customer',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  \`);

  await db.execute(\`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL,
      currency TEXT DEFAULT 'USD',
      category TEXT,
      inventory INTEGER DEFAULT 0,
      image_urls TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  \`);

  await db.execute(\`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      items TEXT NOT NULL,
      total_cents INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      shipping_address TEXT,
      payment_intent_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  \`);

  await db.execute(\`
    CREATE TABLE IF NOT EXISTS carts (
      user_id TEXT PRIMARY KEY,
      items TEXT NOT NULL DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  \`);
}
`
  );

  // Services
  writeFile(
    dir,
    "src/services/product-service.ts",
    `import { getDatabase } from "../database/connection.js";
import type { Product, CreateProductInput, ProductSearchFilters } from "../types/product.js";

/** Create a new product in the catalog */
export async function createProduct(input: CreateProductInput): Promise<Product> {
  const db = await getDatabase();
  const product: Product = {
    id: \`prod_\${Math.random().toString(36).slice(2)}\`,
    ...input,
    currency: "USD",
    imageUrls: input.imageUrls ?? [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.execute("INSERT INTO products VALUES (?)", [product]);
  return product;
}

/** Get a single product by ID */
export async function getProduct(id: string): Promise<Product | null> {
  const db = await getDatabase();
  const rows = await db.query<Product>("SELECT * FROM products WHERE id = ?", [id]);
  return rows[0] ?? null;
}

/** Search products with filters and pagination */
export async function searchProducts(
  filters: ProductSearchFilters,
  page = 1,
  pageSize = 20
): Promise<{ products: Product[]; total: number }> {
  const db = await getDatabase();
  const products = await db.query<Product>("SELECT * FROM products", []);
  return { products, total: products.length };
}

/** Update product inventory after a purchase */
export async function decrementInventory(productId: string, quantity: number): Promise<boolean> {
  const product = await getProduct(productId);
  if (!product || product.inventory < quantity) return false;

  const db = await getDatabase();
  await db.execute("UPDATE products SET inventory = inventory - ? WHERE id = ?", [quantity, productId]);
  return true;
}

/** Check if a product has sufficient inventory */
export async function checkInventory(productId: string, quantity: number): Promise<boolean> {
  const product = await getProduct(productId);
  return product !== null && product.inventory >= quantity;
}
`
  );

  writeFile(
    dir,
    "src/services/order-service.ts",
    `import { getDatabase } from "../database/connection.js";
import { getProduct, decrementInventory } from "./product-service.js";
import { processPayment, refundPayment } from "./payment-service.js";
import type { Order, CreateOrderInput, OrderStatus } from "../types/order.js";

/** Create a new order from cart items */
export async function createOrder(userId: string, input: CreateOrderInput): Promise<Order> {
  const db = await getDatabase();

  // Resolve product details and calculate total
  let totalCents = 0;
  const items = [];
  for (const item of input.items) {
    const product = await getProduct(item.productId);
    if (!product) throw new Error(\`Product \${item.productId} not found\`);
    if (product.inventory < item.quantity) {
      throw new Error(\`Insufficient inventory for \${product.name}\`);
    }
    totalCents += product.priceCents * item.quantity;
    items.push({
      productId: product.id,
      productName: product.name,
      quantity: item.quantity,
      unitPriceCents: product.priceCents,
    });
  }

  const order: Order = {
    id: \`ord_\${Math.random().toString(36).slice(2)}\`,
    userId,
    items,
    totalCents,
    status: "pending",
    shippingAddress: input.shippingAddress,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.execute("INSERT INTO orders VALUES (?)", [order]);

  // Decrement inventory for each item
  for (const item of input.items) {
    await decrementInventory(item.productId, item.quantity);
  }

  return order;
}

/** Process payment for an order */
export async function payOrder(orderId: string): Promise<Order> {
  const order = await getOrder(orderId);
  if (!order) throw new Error("Order not found");
  if (order.status !== "pending") throw new Error(\`Cannot pay order in status: \${order.status}\`);

  const paymentResult = await processPayment(order.totalCents, "USD");
  if (!paymentResult.success) {
    throw new Error(\`Payment failed: \${paymentResult.error}\`);
  }

  order.status = "paid";
  order.paymentIntentId = paymentResult.paymentIntentId;
  order.updatedAt = new Date();
  return order;
}

/** Cancel an order and refund if paid */
export async function cancelOrder(orderId: string): Promise<Order> {
  const order = await getOrder(orderId);
  if (!order) throw new Error("Order not found");

  if (order.status === "paid" && order.paymentIntentId) {
    await refundPayment(order.paymentIntentId);
    order.status = "refunded";
  } else {
    order.status = "cancelled";
  }
  order.updatedAt = new Date();
  return order;
}

/** Get a single order by ID */
export async function getOrder(orderId: string): Promise<Order | null> {
  const db = await getDatabase();
  const rows = await db.query<Order>("SELECT * FROM orders WHERE id = ?", [orderId]);
  return rows[0] ?? null;
}

/** Get all orders for a user */
export async function getUserOrders(userId: string): Promise<Order[]> {
  const db = await getDatabase();
  return db.query<Order>("SELECT * FROM orders WHERE user_id = ?", [userId]);
}

/** Update order status (admin only) */
export async function updateOrderStatus(orderId: string, status: OrderStatus): Promise<Order> {
  const order = await getOrder(orderId);
  if (!order) throw new Error("Order not found");
  order.status = status;
  order.updatedAt = new Date();
  return order;
}
`
  );

  writeFile(
    dir,
    "src/services/payment-service.ts",
    `import { loadConfig } from "../config.js";

export interface PaymentResult {
  success: boolean;
  paymentIntentId?: string;
  error?: string;
}

export interface RefundResult {
  success: boolean;
  refundId?: string;
  error?: string;
}

/** Process a payment through the payment gateway */
export async function processPayment(
  amountCents: number,
  currency: string
): Promise<PaymentResult> {
  const config = loadConfig();
  if (!config.stripeSecretKey) {
    return { success: false, error: "Payment gateway not configured" };
  }

  // Simplified: in production, call Stripe API
  if (amountCents <= 0) {
    return { success: false, error: "Invalid payment amount" };
  }

  return {
    success: true,
    paymentIntentId: \`pi_\${Math.random().toString(36).slice(2)}\`,
  };
}

/** Refund a previously processed payment */
export async function refundPayment(paymentIntentId: string): Promise<RefundResult> {
  if (!paymentIntentId.startsWith("pi_")) {
    return { success: false, error: "Invalid payment intent ID" };
  }

  return {
    success: true,
    refundId: \`re_\${Math.random().toString(36).slice(2)}\`,
  };
}

/** Verify a webhook signature from the payment provider */
export function verifyWebhookSignature(payload: string, signature: string): boolean {
  const config = loadConfig();
  // Simplified: in production, verify HMAC
  return signature.length > 0 && config.stripeSecretKey.length > 0;
}
`
  );

  writeFile(
    dir,
    "src/services/cart-service.ts",
    `import { getDatabase } from "../database/connection.js";
import { getProduct } from "./product-service.js";
import type { Cart, CartItem } from "../types/cart.js";

/** Get the cart for a user */
export async function getCart(userId: string): Promise<Cart> {
  const db = await getDatabase();
  const rows = await db.query<Cart>("SELECT * FROM carts WHERE user_id = ?", [userId]);
  return rows[0] ?? { userId, items: [], updatedAt: new Date() };
}

/** Add an item to the user's cart */
export async function addToCart(userId: string, productId: string, quantity: number): Promise<Cart> {
  const product = await getProduct(productId);
  if (!product) throw new Error("Product not found");
  if (product.inventory < quantity) throw new Error("Insufficient inventory");

  const cart = await getCart(userId);
  const existing = cart.items.find(i => i.productId === productId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.items.push({ productId, quantity, addedAt: new Date() });
  }
  cart.updatedAt = new Date();
  return cart;
}

/** Remove an item from the cart */
export async function removeFromCart(userId: string, productId: string): Promise<Cart> {
  const cart = await getCart(userId);
  cart.items = cart.items.filter(i => i.productId !== productId);
  cart.updatedAt = new Date();
  return cart;
}

/** Clear the entire cart */
export async function clearCart(userId: string): Promise<Cart> {
  return { userId, items: [], updatedAt: new Date() };
}

/** Calculate cart total */
export async function getCartTotal(userId: string): Promise<number> {
  const cart = await getCart(userId);
  let total = 0;
  for (const item of cart.items) {
    const product = await getProduct(item.productId);
    if (product) total += product.priceCents * item.quantity;
  }
  return total;
}
`
  );

  writeFile(
    dir,
    "src/services/user-service.ts",
    `import { getDatabase } from "../database/connection.js";
import type { User, CreateUserInput, LoginInput, AuthToken } from "../types/user.js";

/** Register a new user account */
export async function registerUser(input: CreateUserInput): Promise<User> {
  const db = await getDatabase();

  // Check for existing user
  const existing = await db.query<User>("SELECT * FROM users WHERE email = ?", [input.email]);
  if (existing.length > 0) {
    throw new Error("Email already registered");
  }

  const user: User = {
    id: \`usr_\${Math.random().toString(36).slice(2)}\`,
    email: input.email,
    passwordHash: hashPassword(input.password),
    name: input.name,
    role: "customer",
    createdAt: new Date(),
  };

  await db.execute("INSERT INTO users VALUES (?)", [user]);
  return user;
}

/** Authenticate a user and return tokens */
export async function loginUser(input: LoginInput): Promise<AuthToken> {
  const db = await getDatabase();
  const rows = await db.query<User>("SELECT * FROM users WHERE email = ?", [input.email]);
  const user = rows[0];

  if (!user || !verifyPassword(input.password, user.passwordHash)) {
    throw new Error("Invalid email or password");
  }

  return generateAuthTokens(user);
}

/** Get user profile by ID */
export async function getUserProfile(userId: string): Promise<Omit<User, "passwordHash"> | null> {
  const db = await getDatabase();
  const rows = await db.query<User>("SELECT * FROM users WHERE id = ?", [userId]);
  if (rows.length === 0) return null;
  const { passwordHash, ...profile } = rows[0];
  return profile;
}

function hashPassword(password: string): string {
  // Simplified: in production use bcrypt
  return Buffer.from(password).toString("base64");
}

function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

function generateAuthTokens(user: User): AuthToken {
  return {
    accessToken: Buffer.from(JSON.stringify({ userId: user.id, role: user.role })).toString("base64"),
    refreshToken: \`rt_\${Math.random().toString(36).slice(2)}\`,
    expiresIn: 3600,
  };
}
`
  );

  // Middleware
  writeFile(
    dir,
    "src/middleware/auth.ts",
    `import type { User } from "../types/user.js";

export interface AuthContext {
  userId: string;
  role: User["role"];
}

/** Extract and validate the auth token from request headers */
export function extractAuth(authHeader?: string): AuthContext | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    const payload = JSON.parse(Buffer.from(token, "base64").toString("utf-8"));
    return { userId: payload.userId, role: payload.role };
  } catch {
    return null;
  }
}

/** Require authentication — returns 401 error object if not authenticated */
export function requireAuth(authHeader?: string): AuthContext | { error: string; status: 401 } {
  const auth = extractAuth(authHeader);
  if (!auth) return { error: "Unauthorized", status: 401 };
  return auth;
}

/** Require admin role — returns 403 error object if not admin */
export function requireAdmin(authHeader?: string): AuthContext | { error: string; status: number } {
  const auth = requireAuth(authHeader);
  if ("error" in auth) return auth;
  if (auth.role !== "admin") return { error: "Admin access required", status: 403 };
  return auth;
}
`
  );

  writeFile(
    dir,
    "src/middleware/validation.ts",
    `export interface ValidationError {
  field: string;
  message: string;
}

export type ValidationResult = { valid: true } | { valid: false; errors: ValidationError[] };

/** Validate that required fields are present and non-empty */
export function validateRequired(data: Record<string, unknown>, fields: string[]): ValidationResult {
  const errors: ValidationError[] = [];
  for (const field of fields) {
    if (data[field] === undefined || data[field] === null || data[field] === "") {
      errors.push({ field, message: \`\${field} is required\` });
    }
  }
  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/** Validate email format */
export function validateEmail(email: string): boolean {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
}

/** Validate price is a positive integer (cents) */
export function validatePrice(priceCents: number): boolean {
  return Number.isInteger(priceCents) && priceCents > 0;
}

/** Validate pagination parameters */
export function validatePagination(page?: number, pageSize?: number): { page: number; pageSize: number } {
  return {
    page: Math.max(1, page ?? 1),
    pageSize: Math.min(100, Math.max(1, pageSize ?? 20)),
  };
}
`
  );

  writeFile(
    dir,
    "src/middleware/error-handler.ts",
    `export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, \`\${resource} not found\`, "NOT_FOUND");
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message, "VALIDATION_ERROR");
  }
}

export class PaymentError extends AppError {
  constructor(message: string) {
    super(402, message, "PAYMENT_FAILED");
  }
}

/** Global error handler — formats errors into a consistent API response */
export function handleError(error: unknown): { status: number; body: { error: string; code?: string } } {
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      body: { error: error.message, code: error.code },
    };
  }

  // Unknown error — log and return generic 500
  console.error("Unexpected error:", error);
  return {
    status: 500,
    body: { error: "Internal server error", code: "INTERNAL_ERROR" },
  };
}
`
  );

  writeFile(
    dir,
    "src/middleware/rate-limiter.ts",
    `interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const limits = new Map<string, RateLimitEntry>();

/** Check rate limit for a given key (e.g., IP address or user ID) */
export function checkRateLimit(
  key: string,
  maxRequests = 100,
  windowMs = 60_000
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let entry = limits.get(key);

  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs };
    limits.set(key, entry);
  }

  entry.count++;
  const allowed = entry.count <= maxRequests;

  return {
    allowed,
    remaining: Math.max(0, maxRequests - entry.count),
    resetAt: entry.resetAt,
  };
}

/** Reset rate limit for a key */
export function resetRateLimit(key: string): void {
  limits.delete(key);
}
`
  );

  // Routes
  writeFile(
    dir,
    "src/routes/product-routes.ts",
    `import { searchProducts, getProduct, createProduct } from "../services/product-service.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { validateRequired, validatePrice, validatePagination } from "../middleware/validation.js";
import { handleError, NotFoundError, ValidationError } from "../middleware/error-handler.js";
import type { CreateProductInput, ProductSearchFilters } from "../types/product.js";

/** GET /products — list and search products */
export async function listProducts(query: ProductSearchFilters & { page?: number; pageSize?: number }) {
  try {
    const { page, pageSize } = validatePagination(query.page, query.pageSize);
    return await searchProducts(query, page, pageSize);
  } catch (error) {
    return handleError(error);
  }
}

/** GET /products/:id — get a single product */
export async function getProductById(id: string) {
  try {
    const product = await getProduct(id);
    if (!product) throw new NotFoundError("Product");
    return product;
  } catch (error) {
    return handleError(error);
  }
}

/** POST /products — create a product (admin only) */
export async function createProductRoute(authHeader: string | undefined, body: CreateProductInput) {
  try {
    const auth = requireAdmin(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };

    const validation = validateRequired(body as unknown as Record<string, unknown>, ["name", "priceCents", "category"]);
    if (!validation.valid) throw new ValidationError(validation.errors[0].message);
    if (!validatePrice(body.priceCents)) throw new ValidationError("Invalid price");

    return await createProduct(body);
  } catch (error) {
    return handleError(error);
  }
}
`
  );

  writeFile(
    dir,
    "src/routes/order-routes.ts",
    `import { createOrder, getOrder, getUserOrders, cancelOrder, payOrder } from "../services/order-service.js";
import { requireAuth } from "../middleware/auth.js";
import { handleError, NotFoundError } from "../middleware/error-handler.js";
import type { CreateOrderInput } from "../types/order.js";

/** POST /orders — create a new order */
export async function createOrderRoute(authHeader: string | undefined, body: CreateOrderInput) {
  try {
    const auth = requireAuth(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    return await createOrder(auth.userId, body);
  } catch (error) {
    return handleError(error);
  }
}

/** GET /orders/:id — get order details */
export async function getOrderRoute(authHeader: string | undefined, orderId: string) {
  try {
    const auth = requireAuth(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };

    const order = await getOrder(orderId);
    if (!order) throw new NotFoundError("Order");
    if (order.userId !== auth.userId && auth.role !== "admin") {
      return { status: 403, body: { error: "Access denied" } };
    }
    return order;
  } catch (error) {
    return handleError(error);
  }
}

/** GET /orders — get user's orders */
export async function listOrdersRoute(authHeader: string | undefined) {
  try {
    const auth = requireAuth(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    return await getUserOrders(auth.userId);
  } catch (error) {
    return handleError(error);
  }
}

/** POST /orders/:id/pay — process payment */
export async function payOrderRoute(authHeader: string | undefined, orderId: string) {
  try {
    const auth = requireAuth(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    return await payOrder(orderId);
  } catch (error) {
    return handleError(error);
  }
}

/** POST /orders/:id/cancel — cancel an order */
export async function cancelOrderRoute(authHeader: string | undefined, orderId: string) {
  try {
    const auth = requireAuth(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    return await cancelOrder(orderId);
  } catch (error) {
    return handleError(error);
  }
}
`
  );

  writeFile(
    dir,
    "src/routes/cart-routes.ts",
    `import { getCart, addToCart, removeFromCart, clearCart, getCartTotal } from "../services/cart-service.js";
import { requireAuth } from "../middleware/auth.js";
import { handleError } from "../middleware/error-handler.js";

/** GET /cart — get user's cart */
export async function getCartRoute(authHeader: string | undefined) {
  try {
    const auth = requireAuth(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    const cart = await getCart(auth.userId);
    const total = await getCartTotal(auth.userId);
    return { ...cart, totalCents: total };
  } catch (error) {
    return handleError(error);
  }
}

/** POST /cart/items — add item to cart */
export async function addToCartRoute(
  authHeader: string | undefined,
  body: { productId: string; quantity: number }
) {
  try {
    const auth = requireAuth(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    return await addToCart(auth.userId, body.productId, body.quantity);
  } catch (error) {
    return handleError(error);
  }
}

/** DELETE /cart/items/:productId — remove item from cart */
export async function removeFromCartRoute(authHeader: string | undefined, productId: string) {
  try {
    const auth = requireAuth(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    return await removeFromCart(auth.userId, productId);
  } catch (error) {
    return handleError(error);
  }
}

/** DELETE /cart — clear cart */
export async function clearCartRoute(authHeader: string | undefined) {
  try {
    const auth = requireAuth(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    return await clearCart(auth.userId);
  } catch (error) {
    return handleError(error);
  }
}
`
  );

  writeFile(
    dir,
    "src/routes/user-routes.ts",
    `import { registerUser, loginUser, getUserProfile } from "../services/user-service.js";
import { requireAuth } from "../middleware/auth.js";
import { validateRequired, validateEmail } from "../middleware/validation.js";
import { handleError, ValidationError } from "../middleware/error-handler.js";
import { checkRateLimit } from "../middleware/rate-limiter.js";
import type { CreateUserInput, LoginInput } from "../types/user.js";

/** POST /register — create new user account */
export async function registerRoute(body: CreateUserInput, clientIp: string) {
  try {
    const limit = checkRateLimit(\`register:\${clientIp}\`, 5, 60_000);
    if (!limit.allowed) return { status: 429, body: { error: "Too many requests" } };

    const validation = validateRequired(body as unknown as Record<string, unknown>, ["email", "password", "name"]);
    if (!validation.valid) throw new ValidationError(validation.errors[0].message);
    if (!validateEmail(body.email)) throw new ValidationError("Invalid email format");

    const user = await registerUser(body);
    return { id: user.id, email: user.email, name: user.name };
  } catch (error) {
    return handleError(error);
  }
}

/** POST /login — authenticate user */
export async function loginRoute(body: LoginInput, clientIp: string) {
  try {
    const limit = checkRateLimit(\`login:\${clientIp}\`, 10, 60_000);
    if (!limit.allowed) return { status: 429, body: { error: "Too many requests" } };

    return await loginUser(body);
  } catch (error) {
    return handleError(error);
  }
}

/** GET /profile — get current user's profile */
export async function profileRoute(authHeader: string | undefined) {
  try {
    const auth = requireAuth(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    return await getUserProfile(auth.userId);
  } catch (error) {
    return handleError(error);
  }
}
`
  );

  // Utilities
  writeFile(
    dir,
    "src/utils/logger.ts",
    `export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel: LogLevel = "info";

/** Set the minimum log level */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Log a message at the given level */
export function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

/** Log at debug level */
export function debug(message: string, data?: Record<string, unknown>): void {
  log("debug", message, data);
}

/** Log at info level */
export function info(message: string, data?: Record<string, unknown>): void {
  log("info", message, data);
}

/** Log at warn level */
export function warn(message: string, data?: Record<string, unknown>): void {
  log("warn", message, data);
}

/** Log at error level */
export function error(message: string, data?: Record<string, unknown>): void {
  log("error", message, data);
}
`
  );

  writeFile(
    dir,
    "src/utils/pagination.ts",
    `export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Wrap results in a paginated response */
export function paginate<T>(data: T[], total: number, page: number, pageSize: number): PaginatedResponse<T> {
  return {
    data,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}
`
  );

  // App entry
  writeFile(
    dir,
    "src/app.ts",
    `import { loadConfig } from "./config.js";
import { runMigrations } from "./database/migrations.js";
import { info, setLogLevel } from "./utils/logger.js";

/** Initialize and start the e-commerce application */
export async function startApp(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  info("Starting e-commerce API", { port: config.port });

  // Run database migrations
  await runMigrations();
  info("Database migrations complete");

  // In production: set up HTTP server with routes
  info("Server listening", { port: config.port });
}

/** Gracefully shut down the application */
export async function stopApp(): Promise<void> {
  info("Shutting down...");
  // Close database connections, etc.
}
`
  );

  return { name: "medium", fileCount: 21, approxLoc: 1500, dir };
}

// ─── Large Codebase: Full-Stack Platform (~80 files, ~6000 LOC) ───

export function generateLargeCodebase(dir: string): GeneratedCodebase {
  // We reuse the medium codebase as the base API layer,
  // then add: models, services, workers, websocket, CLI, migrations, test helpers, config, shared utils

  // Start with all medium codebase files
  generateMediumCodebase(dir);

  // ─── Database Models ───
  writeFile(
    dir,
    "src/models/base-model.ts",
    `import { getDatabase } from "../database/connection.js";

export abstract class BaseModel {
  abstract tableName: string;

  async findById<T>(id: string): Promise<T | null> {
    const db = await getDatabase();
    const rows = await db.query<T>(\`SELECT * FROM \${this.tableName} WHERE id = ?\`, [id]);
    return rows[0] ?? null;
  }

  async findAll<T>(limit = 100, offset = 0): Promise<T[]> {
    const db = await getDatabase();
    return db.query<T>(\`SELECT * FROM \${this.tableName} LIMIT ? OFFSET ?\`, [limit, offset]);
  }

  async count(): Promise<number> {
    const db = await getDatabase();
    const rows = await db.query<{ count: number }>(\`SELECT COUNT(*) as count FROM \${this.tableName}\`);
    return rows[0]?.count ?? 0;
  }

  async deleteById(id: string): Promise<boolean> {
    const db = await getDatabase();
    const result = await db.execute(\`DELETE FROM \${this.tableName} WHERE id = ?\`, [id]);
    return result.changes > 0;
  }
}
`
  );

  writeFile(
    dir,
    "src/models/user-model.ts",
    `import { BaseModel } from "./base-model.js";
import { getDatabase } from "../database/connection.js";
import type { User } from "../types/user.js";

export class UserModel extends BaseModel {
  tableName = "users";

  async findByEmail(email: string): Promise<User | null> {
    const db = await getDatabase();
    const rows = await db.query<User>("SELECT * FROM users WHERE email = ?", [email]);
    return rows[0] ?? null;
  }

  async create(user: User): Promise<User> {
    const db = await getDatabase();
    await db.execute(
      "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [user.id, user.email, user.passwordHash, user.name, user.role, user.createdAt]
    );
    return user;
  }

  async updateRole(userId: string, role: User["role"]): Promise<void> {
    const db = await getDatabase();
    await db.execute("UPDATE users SET role = ? WHERE id = ?", [role, userId]);
  }

  async search(query: string, limit = 20): Promise<User[]> {
    const db = await getDatabase();
    return db.query<User>("SELECT * FROM users WHERE name LIKE ? OR email LIKE ?", [\`%\${query}%\`, \`%\${query}%\`]);
  }
}

export const userModel = new UserModel();
`
  );

  writeFile(
    dir,
    "src/models/product-model.ts",
    `import { BaseModel } from "./base-model.js";
import { getDatabase } from "../database/connection.js";
import type { Product } from "../types/product.js";

export class ProductModel extends BaseModel {
  tableName = "products";

  async findByCategory(category: string, limit = 50): Promise<Product[]> {
    const db = await getDatabase();
    return db.query<Product>("SELECT * FROM products WHERE category = ? LIMIT ?", [category, limit]);
  }

  async create(product: Product): Promise<Product> {
    const db = await getDatabase();
    await db.execute(
      "INSERT INTO products (id, name, description, price_cents, currency, category, inventory) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [product.id, product.name, product.description, product.priceCents, product.currency, product.category, product.inventory]
    );
    return product;
  }

  async updateInventory(productId: string, delta: number): Promise<void> {
    const db = await getDatabase();
    await db.execute("UPDATE products SET inventory = inventory + ? WHERE id = ?", [delta, productId]);
  }

  async searchByName(query: string, limit = 20): Promise<Product[]> {
    const db = await getDatabase();
    return db.query<Product>("SELECT * FROM products WHERE name LIKE ?", [\`%\${query}%\`]);
  }

  async getOutOfStock(): Promise<Product[]> {
    const db = await getDatabase();
    return db.query<Product>("SELECT * FROM products WHERE inventory <= 0");
  }
}

export const productModel = new ProductModel();
`
  );

  writeFile(
    dir,
    "src/models/order-model.ts",
    `import { BaseModel } from "./base-model.js";
import { getDatabase } from "../database/connection.js";
import type { Order, OrderStatus } from "../types/order.js";

export class OrderModel extends BaseModel {
  tableName = "orders";

  async findByUserId(userId: string): Promise<Order[]> {
    const db = await getDatabase();
    return db.query<Order>("SELECT * FROM orders WHERE user_id = ?", [userId]);
  }

  async findByStatus(status: OrderStatus): Promise<Order[]> {
    const db = await getDatabase();
    return db.query<Order>("SELECT * FROM orders WHERE status = ?", [status]);
  }

  async create(order: Order): Promise<Order> {
    const db = await getDatabase();
    await db.execute(
      "INSERT INTO orders (id, user_id, items, total_cents, status, shipping_address) VALUES (?, ?, ?, ?, ?, ?)",
      [order.id, order.userId, JSON.stringify(order.items), order.totalCents, order.status, JSON.stringify(order.shippingAddress)]
    );
    return order;
  }

  async updateStatus(orderId: string, status: OrderStatus): Promise<void> {
    const db = await getDatabase();
    await db.execute("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?", [status, new Date().toISOString(), orderId]);
  }

  async getRevenueByDay(days = 30): Promise<Array<{ date: string; revenue: number }>> {
    const db = await getDatabase();
    return db.query("SELECT date(created_at) as date, SUM(total_cents) as revenue FROM orders WHERE status = 'paid' GROUP BY date(created_at) ORDER BY date DESC LIMIT ?", [days]);
  }
}

export const orderModel = new OrderModel();
`
  );

  // ─── Additional Services ───
  writeFile(
    dir,
    "src/services/notification-service.ts",
    `import { info, warn } from "../utils/logger.js";

export type NotificationType = "order_confirmation" | "order_shipped" | "order_delivered" | "payment_failed" | "welcome";

interface NotificationPayload {
  type: NotificationType;
  userId: string;
  email: string;
  data: Record<string, unknown>;
}

/** Send a notification to a user via email */
export async function sendNotification(payload: NotificationPayload): Promise<boolean> {
  info("Sending notification", { type: payload.type, userId: payload.userId });

  switch (payload.type) {
    case "order_confirmation":
      return sendEmail(payload.email, "Order Confirmed", formatOrderConfirmation(payload.data));
    case "order_shipped":
      return sendEmail(payload.email, "Order Shipped", formatShippingNotification(payload.data));
    case "payment_failed":
      return sendEmail(payload.email, "Payment Failed", formatPaymentFailure(payload.data));
    case "welcome":
      return sendEmail(payload.email, "Welcome!", formatWelcomeEmail(payload.data));
    default:
      warn("Unknown notification type", { type: payload.type });
      return false;
  }
}

async function sendEmail(to: string, subject: string, body: string): Promise<boolean> {
  // Simplified: in production, use email service (SES, SendGrid, etc.)
  info("Email sent", { to, subject });
  return true;
}

function formatOrderConfirmation(data: Record<string, unknown>): string {
  return \`Your order \${data.orderId} has been confirmed. Total: $\${(data.totalCents as number) / 100}\`;
}

function formatShippingNotification(data: Record<string, unknown>): string {
  return \`Your order \${data.orderId} has been shipped. Tracking: \${data.trackingNumber}\`;
}

function formatPaymentFailure(data: Record<string, unknown>): string {
  return \`Payment failed for order \${data.orderId}. Reason: \${data.reason}. Please update your payment method.\`;
}

function formatWelcomeEmail(data: Record<string, unknown>): string {
  return \`Welcome to our store, \${data.name}! Start shopping today.\`;
}
`
  );

  writeFile(
    dir,
    "src/services/search-service.ts",
    `import { getDatabase } from "../database/connection.js";
import type { Product } from "../types/product.js";
import type { Order } from "../types/order.js";

export interface SearchResults {
  products: Product[];
  orders: Order[];
  total: number;
}

/** Full-text search across products and orders */
export async function globalSearch(query: string, userId?: string): Promise<SearchResults> {
  const db = await getDatabase();

  const products = await db.query<Product>(
    "SELECT * FROM products WHERE name LIKE ? OR description LIKE ?",
    [\`%\${query}%\`, \`%\${query}%\`]
  );

  let orders: Order[] = [];
  if (userId) {
    orders = await db.query<Order>(
      "SELECT * FROM orders WHERE user_id = ? AND id LIKE ?",
      [userId, \`%\${query}%\`]
    );
  }

  return { products, orders, total: products.length + orders.length };
}

/** Get trending products based on recent orders */
export async function getTrendingProducts(limit = 10): Promise<Product[]> {
  const db = await getDatabase();
  return db.query<Product>(
    "SELECT p.* FROM products p INNER JOIN (SELECT items FROM orders WHERE created_at > datetime('now', '-7 days')) o ON 1=1 LIMIT ?",
    [limit]
  );
}
`
  );

  writeFile(
    dir,
    "src/services/analytics-service.ts",
    `import { getDatabase } from "../database/connection.js";

export interface DashboardMetrics {
  totalRevenue: number;
  totalOrders: number;
  averageOrderValue: number;
  topCategories: Array<{ category: string; count: number }>;
  recentActivity: Array<{ type: string; timestamp: string; details: string }>;
}

/** Get dashboard metrics for the admin panel */
export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const db = await getDatabase();

  const revenueRows = await db.query<{ total: number }>(
    "SELECT COALESCE(SUM(total_cents), 0) as total FROM orders WHERE status = 'paid'"
  );
  const totalRevenue = revenueRows[0]?.total ?? 0;

  const orderCountRows = await db.query<{ count: number }>(
    "SELECT COUNT(*) as count FROM orders"
  );
  const totalOrders = orderCountRows[0]?.count ?? 0;

  return {
    totalRevenue,
    totalOrders,
    averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
    topCategories: [],
    recentActivity: [],
  };
}

/** Track a user action for analytics */
export async function trackEvent(
  userId: string,
  eventType: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const db = await getDatabase();
  await db.execute(
    "INSERT INTO analytics_events (user_id, event_type, metadata, created_at) VALUES (?, ?, ?, ?)",
    [userId, eventType, JSON.stringify(metadata), new Date().toISOString()]
  );
}
`
  );

  writeFile(
    dir,
    "src/services/inventory-service.ts",
    `import { productModel } from "../models/product-model.js";
import { sendNotification } from "./notification-service.js";
import { warn, info } from "../utils/logger.js";
import type { Product } from "../types/product.js";

const LOW_STOCK_THRESHOLD = 5;

/** Check inventory levels and alert on low stock */
export async function checkLowStock(): Promise<Product[]> {
  const outOfStock = await productModel.getOutOfStock();
  if (outOfStock.length > 0) {
    warn("Out of stock products detected", { count: outOfStock.length });
  }
  return outOfStock;
}

/** Reserve inventory for an order (with rollback on failure) */
export async function reserveInventory(
  items: Array<{ productId: string; quantity: number }>
): Promise<{ success: boolean; failedItem?: string }> {
  const reserved: Array<{ productId: string; quantity: number }> = [];

  for (const item of items) {
    const product = await productModel.findById<Product>(item.productId);
    if (!product || product.inventory < item.quantity) {
      // Rollback previously reserved items
      for (const r of reserved) {
        await productModel.updateInventory(r.productId, r.quantity);
      }
      return { success: false, failedItem: item.productId };
    }

    await productModel.updateInventory(item.productId, -item.quantity);
    reserved.push(item);

    // Check low stock threshold
    if (product.inventory - item.quantity <= LOW_STOCK_THRESHOLD) {
      info("Low stock alert", { productId: item.productId, remaining: product.inventory - item.quantity });
    }
  }

  return { success: true };
}

/** Release reserved inventory (e.g., on order cancellation) */
export async function releaseInventory(
  items: Array<{ productId: string; quantity: number }>
): Promise<void> {
  for (const item of items) {
    await productModel.updateInventory(item.productId, item.quantity);
  }
}
`
  );

  // ─── Workers ───
  writeFile(
    dir,
    "src/workers/order-processor.ts",
    `import { orderModel } from "../models/order-model.js";
import { sendNotification } from "../services/notification-service.js";
import { userModel } from "../models/user-model.js";
import { info, error as logError } from "../utils/logger.js";
import type { Order } from "../types/order.js";
import type { User } from "../types/user.js";

export interface JobPayload {
  orderId: string;
  action: "process" | "ship" | "deliver";
}

/** Process an order job from the queue */
export async function processOrderJob(payload: JobPayload): Promise<void> {
  info("Processing order job", { orderId: payload.orderId, action: payload.action });

  const order = await orderModel.findById<Order>(payload.orderId);
  if (!order) {
    logError("Order not found for job", { orderId: payload.orderId });
    return;
  }

  const user = await userModel.findById<User>(order.userId);
  if (!user) {
    logError("User not found for order", { userId: order.userId });
    return;
  }

  switch (payload.action) {
    case "process":
      await orderModel.updateStatus(order.id, "paid");
      await sendNotification({
        type: "order_confirmation",
        userId: user.id,
        email: user.email,
        data: { orderId: order.id, totalCents: order.totalCents },
      });
      break;

    case "ship":
      await orderModel.updateStatus(order.id, "shipped");
      await sendNotification({
        type: "order_shipped",
        userId: user.id,
        email: user.email,
        data: { orderId: order.id, trackingNumber: \`TRK\${Date.now()}\` },
      });
      break;

    case "deliver":
      await orderModel.updateStatus(order.id, "delivered");
      await sendNotification({
        type: "order_delivered",
        userId: user.id,
        email: user.email,
        data: { orderId: order.id },
      });
      break;
  }
}
`
  );

  writeFile(
    dir,
    "src/workers/email-worker.ts",
    `import { info, error as logError } from "../utils/logger.js";

export interface EmailJob {
  to: string;
  subject: string;
  body: string;
  retryCount?: number;
}

const MAX_RETRIES = 3;
const emailQueue: EmailJob[] = [];

/** Enqueue an email for delivery */
export function enqueueEmail(job: EmailJob): void {
  emailQueue.push({ ...job, retryCount: 0 });
  info("Email enqueued", { to: job.to, subject: job.subject });
}

/** Process the next email in the queue */
export async function processEmailQueue(): Promise<number> {
  let processed = 0;

  while (emailQueue.length > 0) {
    const job = emailQueue.shift()!;
    try {
      await deliverEmail(job);
      processed++;
      info("Email delivered", { to: job.to });
    } catch (err) {
      if ((job.retryCount ?? 0) < MAX_RETRIES) {
        job.retryCount = (job.retryCount ?? 0) + 1;
        emailQueue.push(job);
        logError("Email delivery failed, retrying", { to: job.to, attempt: job.retryCount });
      } else {
        logError("Email delivery permanently failed", { to: job.to });
      }
    }
  }

  return processed;
}

async function deliverEmail(job: EmailJob): Promise<void> {
  // Simplified: integrate with SES/SendGrid
  if (!job.to.includes("@")) {
    throw new Error("Invalid email address");
  }
}

/** Get the current queue length */
export function getQueueLength(): number {
  return emailQueue.length;
}
`
  );

  writeFile(
    dir,
    "src/workers/cleanup-worker.ts",
    `import { getDatabase } from "../database/connection.js";
import { info } from "../utils/logger.js";

/** Remove expired sessions from the database */
export async function cleanupExpiredSessions(): Promise<number> {
  const db = await getDatabase();
  const result = await db.execute(
    "DELETE FROM sessions WHERE expires_at < ?",
    [new Date().toISOString()]
  );
  info("Cleaned up expired sessions", { count: result.changes });
  return result.changes;
}

/** Archive old orders (older than 90 days) */
export async function archiveOldOrders(): Promise<number> {
  const db = await getDatabase();
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.execute(
    "UPDATE orders SET status = 'archived' WHERE status = 'delivered' AND updated_at < ?",
    [cutoff]
  );
  info("Archived old orders", { count: result.changes });
  return result.changes;
}

/** Purge old analytics events */
export async function purgeOldAnalytics(daysToKeep = 365): Promise<number> {
  const db = await getDatabase();
  const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.execute(
    "DELETE FROM analytics_events WHERE created_at < ?",
    [cutoff]
  );
  info("Purged old analytics", { count: result.changes, daysKept: daysToKeep });
  return result.changes;
}

/** Run all cleanup tasks */
export async function runAllCleanup(): Promise<void> {
  await cleanupExpiredSessions();
  await archiveOldOrders();
  await purgeOldAnalytics();
  info("All cleanup tasks complete");
}
`
  );

  writeFile(
    dir,
    "src/workers/queue.ts",
    `import { info, error as logError } from "../utils/logger.js";

export interface QueueJob<T = unknown> {
  id: string;
  type: string;
  payload: T;
  createdAt: Date;
  attempts: number;
  maxAttempts: number;
}

type JobHandler<T = unknown> = (payload: T) => Promise<void>;

const handlers = new Map<string, JobHandler>();
const jobQueue: QueueJob[] = [];
const deadLetterQueue: QueueJob[] = [];

/** Register a handler for a job type */
export function registerHandler<T>(type: string, handler: JobHandler<T>): void {
  handlers.set(type, handler as JobHandler);
  info("Registered job handler", { type });
}

/** Enqueue a job for processing */
export function enqueueJob<T>(type: string, payload: T, maxAttempts = 3): string {
  const id = \`job_\${Math.random().toString(36).slice(2)}\`;
  jobQueue.push({
    id,
    type,
    payload,
    createdAt: new Date(),
    attempts: 0,
    maxAttempts,
  });
  return id;
}

/** Process all pending jobs */
export async function processJobs(): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;

  while (jobQueue.length > 0) {
    const job = jobQueue.shift()!;
    const handler = handlers.get(job.type);

    if (!handler) {
      logError("No handler for job type", { type: job.type });
      deadLetterQueue.push(job);
      failed++;
      continue;
    }

    job.attempts++;
    try {
      await handler(job.payload);
      processed++;
    } catch (err) {
      if (job.attempts < job.maxAttempts) {
        jobQueue.push(job);
      } else {
        deadLetterQueue.push(job);
        failed++;
        logError("Job permanently failed", { id: job.id, type: job.type });
      }
    }
  }

  return { processed, failed };
}

/** Get dead letter queue contents */
export function getDeadLetterQueue(): QueueJob[] {
  return [...deadLetterQueue];
}
`
  );

  // ─── WebSocket ───
  writeFile(
    dir,
    "src/websocket/connection-manager.ts",
    `import { info, warn } from "../utils/logger.js";

export interface WebSocketClient {
  id: string;
  userId: string;
  connectedAt: Date;
  lastPingAt: Date;
}

const connections = new Map<string, WebSocketClient>();

/** Register a new WebSocket connection */
export function addConnection(clientId: string, userId: string): WebSocketClient {
  const client: WebSocketClient = {
    id: clientId,
    userId,
    connectedAt: new Date(),
    lastPingAt: new Date(),
  };
  connections.set(clientId, client);
  info("WebSocket connected", { clientId, userId });
  return client;
}

/** Remove a WebSocket connection */
export function removeConnection(clientId: string): void {
  connections.delete(clientId);
  info("WebSocket disconnected", { clientId });
}

/** Get all connections for a user */
export function getUserConnections(userId: string): WebSocketClient[] {
  return Array.from(connections.values()).filter(c => c.userId === userId);
}

/** Update last ping time for a connection */
export function updatePing(clientId: string): void {
  const client = connections.get(clientId);
  if (client) client.lastPingAt = new Date();
}

/** Get all active connections */
export function getActiveConnections(): WebSocketClient[] {
  return Array.from(connections.values());
}

/** Remove stale connections (no ping for 60 seconds) */
export function pruneStaleConnections(): number {
  const cutoff = Date.now() - 60_000;
  let pruned = 0;
  for (const [id, client] of connections) {
    if (client.lastPingAt.getTime() < cutoff) {
      connections.delete(id);
      pruned++;
    }
  }
  if (pruned > 0) warn("Pruned stale WebSocket connections", { count: pruned });
  return pruned;
}
`
  );

  writeFile(
    dir,
    "src/websocket/event-broadcaster.ts",
    `import { getUserConnections, getActiveConnections } from "./connection-manager.js";
import { info } from "../utils/logger.js";

export interface WebSocketEvent {
  type: string;
  data: unknown;
  timestamp: string;
}

/** Broadcast an event to a specific user's connections */
export function broadcastToUser(userId: string, event: WebSocketEvent): number {
  const connections = getUserConnections(userId);
  for (const conn of connections) {
    // Simplified: in production, call ws.send()
    info("Broadcasting to user", { userId, clientId: conn.id, eventType: event.type });
  }
  return connections.length;
}

/** Broadcast an event to all connected clients */
export function broadcastToAll(event: WebSocketEvent): number {
  const connections = getActiveConnections();
  for (const conn of connections) {
    info("Broadcasting to all", { clientId: conn.id, eventType: event.type });
  }
  return connections.length;
}

/** Send order status update to the order's user */
export function notifyOrderUpdate(userId: string, orderId: string, status: string): void {
  broadcastToUser(userId, {
    type: "order_status_changed",
    data: { orderId, status },
    timestamp: new Date().toISOString(),
  });
}

/** Send real-time inventory update */
export function notifyInventoryChange(productId: string, newQuantity: number): void {
  broadcastToAll({
    type: "inventory_changed",
    data: { productId, quantity: newQuantity },
    timestamp: new Date().toISOString(),
  });
}
`
  );

  writeFile(
    dir,
    "src/websocket/message-handler.ts",
    `import { updatePing, removeConnection } from "./connection-manager.js";
import { info, warn } from "../utils/logger.js";

export interface IncomingMessage {
  type: string;
  payload?: unknown;
}

/** Handle an incoming WebSocket message */
export function handleMessage(clientId: string, raw: string): void {
  let message: IncomingMessage;
  try {
    message = JSON.parse(raw);
  } catch {
    warn("Invalid WebSocket message", { clientId });
    return;
  }

  switch (message.type) {
    case "ping":
      updatePing(clientId);
      break;
    case "subscribe":
      handleSubscribe(clientId, message.payload as { channel: string });
      break;
    case "unsubscribe":
      handleUnsubscribe(clientId, message.payload as { channel: string });
      break;
    case "disconnect":
      removeConnection(clientId);
      break;
    default:
      warn("Unknown message type", { clientId, type: message.type });
  }
}

function handleSubscribe(clientId: string, payload: { channel: string }): void {
  info("Client subscribed", { clientId, channel: payload.channel });
}

function handleUnsubscribe(clientId: string, payload: { channel: string }): void {
  info("Client unsubscribed", { clientId, channel: payload.channel });
}
`
  );

  // ─── CLI Tools ───
  writeFile(
    dir,
    "src/cli/seed.ts",
    `import { getDatabase } from "../database/connection.js";
import { runMigrations } from "../database/migrations.js";
import { info } from "../utils/logger.js";

const SAMPLE_PRODUCTS = [
  { name: "Wireless Headphones", category: "electronics", priceCents: 7999, inventory: 50 },
  { name: "Running Shoes", category: "sports", priceCents: 12999, inventory: 30 },
  { name: "Coffee Maker", category: "kitchen", priceCents: 4999, inventory: 20 },
  { name: "Laptop Stand", category: "electronics", priceCents: 3499, inventory: 100 },
  { name: "Yoga Mat", category: "sports", priceCents: 2499, inventory: 75 },
];

/** Seed the database with sample data */
export async function seedDatabase(): Promise<void> {
  await runMigrations();
  const db = await getDatabase();

  for (const product of SAMPLE_PRODUCTS) {
    const id = \`prod_\${Math.random().toString(36).slice(2)}\`;
    await db.execute(
      "INSERT INTO products (id, name, category, price_cents, inventory) VALUES (?, ?, ?, ?, ?)",
      [id, product.name, product.category, product.priceCents, product.inventory]
    );
  }

  info("Database seeded", { products: SAMPLE_PRODUCTS.length });
}
`
  );

  writeFile(
    dir,
    "src/cli/migrate.ts",
    `import { runMigrations } from "../database/migrations.js";
import { info, error as logError } from "../utils/logger.js";

/** Run database migrations from CLI */
export async function runMigrateCLI(): Promise<void> {
  try {
    info("Running migrations...");
    await runMigrations();
    info("Migrations complete");
  } catch (err) {
    logError("Migration failed", { error: String(err) });
    process.exit(1);
  }
}
`
  );

  writeFile(
    dir,
    "src/cli/admin.ts",
    `import { userModel } from "../models/user-model.js";
import { orderModel } from "../models/order-model.js";
import { getDashboardMetrics } from "../services/analytics-service.js";
import { info } from "../utils/logger.js";
import type { User } from "../types/user.js";

/** List all admin users */
export async function listAdmins(): Promise<User[]> {
  const users = await userModel.findAll<User>();
  return users.filter(u => u.role === "admin");
}

/** Promote a user to admin */
export async function promoteToAdmin(userId: string): Promise<void> {
  await userModel.updateRole(userId, "admin");
  info("User promoted to admin", { userId });
}

/** Show admin dashboard */
export async function showDashboard(): Promise<void> {
  const metrics = await getDashboardMetrics();
  console.log("Dashboard Metrics:");
  console.log(\`  Revenue: $\${metrics.totalRevenue / 100}\`);
  console.log(\`  Orders: \${metrics.totalOrders}\`);
  console.log(\`  Avg Order: $\${metrics.averageOrderValue / 100}\`);
}
`
  );

  // ─── Database Migrations (numbered) ───
  writeFile(
    dir,
    "src/database/migrations/001-initial.ts",
    `import type { DatabaseConnection } from "../connection.js";

/** Initial schema creation */
export async function up(db: DatabaseConnection): Promise<void> {
  await db.execute(\`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'customer',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  \`);

  await db.execute(\`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL,
      currency TEXT DEFAULT 'USD',
      category TEXT,
      inventory INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  \`);
}

export async function down(db: DatabaseConnection): Promise<void> {
  await db.execute("DROP TABLE IF EXISTS products");
  await db.execute("DROP TABLE IF EXISTS users");
}
`
  );

  writeFile(
    dir,
    "src/database/migrations/002-orders.ts",
    `import type { DatabaseConnection } from "../connection.js";

/** Add orders and carts tables */
export async function up(db: DatabaseConnection): Promise<void> {
  await db.execute(\`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      items TEXT NOT NULL,
      total_cents INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      shipping_address TEXT,
      payment_intent_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  \`);

  await db.execute(\`
    CREATE TABLE IF NOT EXISTS carts (
      user_id TEXT PRIMARY KEY,
      items TEXT NOT NULL DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  \`);
}

export async function down(db: DatabaseConnection): Promise<void> {
  await db.execute("DROP TABLE IF EXISTS carts");
  await db.execute("DROP TABLE IF EXISTS orders");
}
`
  );

  writeFile(
    dir,
    "src/database/migrations/003-analytics.ts",
    `import type { DatabaseConnection } from "../connection.js";

/** Add analytics and sessions tables */
export async function up(db: DatabaseConnection): Promise<void> {
  await db.execute(\`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  \`);

  await db.execute(\`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  \`);

  await db.execute("CREATE INDEX IF NOT EXISTS idx_analytics_user ON analytics_events(user_id)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type)");
}

export async function down(db: DatabaseConnection): Promise<void> {
  await db.execute("DROP TABLE IF EXISTS sessions");
  await db.execute("DROP TABLE IF EXISTS analytics_events");
}
`
  );

  // ─── Config Management ───
  writeFile(
    dir,
    "src/config/environment.ts",
    `export type Environment = "development" | "staging" | "production" | "test";

/** Detect the current environment */
export function getEnvironment(): Environment {
  const env = process.env.NODE_ENV ?? "development";
  if (["development", "staging", "production", "test"].includes(env)) {
    return env as Environment;
  }
  return "development";
}

/** Check if running in production */
export function isProduction(): boolean {
  return getEnvironment() === "production";
}

/** Check if running in development */
export function isDevelopment(): boolean {
  return getEnvironment() === "development";
}

/** Check if running in test */
export function isTest(): boolean {
  return getEnvironment() === "test";
}
`
  );

  writeFile(
    dir,
    "src/config/feature-flags.ts",
    `import { getEnvironment } from "./environment.js";

export interface FeatureFlags {
  enableWebSocket: boolean;
  enableAnalytics: boolean;
  enableEmailNotifications: boolean;
  enableRateLimiting: boolean;
  maintenanceMode: boolean;
}

/** Get feature flags for the current environment */
export function getFeatureFlags(): FeatureFlags {
  const env = getEnvironment();

  return {
    enableWebSocket: env !== "test",
    enableAnalytics: env === "production" || env === "staging",
    enableEmailNotifications: env === "production",
    enableRateLimiting: env !== "test",
    maintenanceMode: false,
  };
}

/** Check if a specific feature is enabled */
export function isFeatureEnabled(flag: keyof FeatureFlags): boolean {
  return getFeatureFlags()[flag];
}
`
  );

  writeFile(
    dir,
    "src/config/cors.ts",
    `import { getEnvironment } from "./environment.js";

export interface CorsConfig {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  maxAge: number;
}

/** Get CORS configuration for the current environment */
export function getCorsConfig(): CorsConfig {
  const env = getEnvironment();

  const allowedOrigins = env === "production"
    ? ["https://shop.example.com"]
    : ["http://localhost:3000", "http://localhost:5173"];

  return {
    allowedOrigins,
    allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  };
}

/** Check if an origin is allowed */
export function isOriginAllowed(origin: string): boolean {
  const config = getCorsConfig();
  return config.allowedOrigins.includes(origin);
}
`
  );

  // ─── Shared Utilities ───
  writeFile(
    dir,
    "src/utils/crypto.ts",
    `/** Generate a random ID with the given prefix */
export function generateId(prefix: string): string {
  return \`\${prefix}_\${Math.random().toString(36).slice(2)}\${Date.now().toString(36)}\`;
}

/** Hash a string using a simple hash (not cryptographic) */
export function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/** Compare two strings in constant time to prevent timing attacks */
export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
`
  );

  writeFile(
    dir,
    "src/utils/date.ts",
    `/** Format a date as ISO string */
export function toISO(date: Date): string {
  return date.toISOString();
}

/** Get a date N days ago */
export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

/** Check if a date is within the last N minutes */
export function isWithinMinutes(date: Date, minutes: number): boolean {
  return Date.now() - date.getTime() < minutes * 60 * 1000;
}

/** Format duration in ms to human readable */
export function formatDuration(ms: number): string {
  if (ms < 1000) return \`\${ms}ms\`;
  if (ms < 60_000) return \`\${(ms / 1000).toFixed(1)}s\`;
  return \`\${(ms / 60_000).toFixed(1)}m\`;
}
`
  );

  writeFile(
    dir,
    "src/utils/retry.ts",
    `import { warn } from "./logger.js";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
};

/** Retry an async operation with exponential backoff */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === opts.maxAttempts) throw err;

      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt - 1),
        opts.maxDelayMs
      );
      warn(\`Retry attempt \${attempt}/\${opts.maxAttempts}\`, { delay, error: String(err) });
      await sleep(delay);
    }
  }

  throw new Error("Unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
`
  );

  writeFile(
    dir,
    "src/utils/cache.ts",
    `interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Simple in-memory cache with TTL */
export class MemoryCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private defaultTtlMs: number;

  constructor(defaultTtlMs = 300_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /** Get a value from the cache */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Set a value in the cache */
  set(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /** Delete a value from the cache */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /** Clear all entries */
  clear(): void {
    this.store.clear();
  }

  /** Get number of entries (including expired) */
  get size(): number {
    return this.store.size;
  }

  /** Remove all expired entries */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt < now) {
        this.store.delete(key);
        pruned++;
      }
    }
    return pruned;
  }
}
`
  );

  // ─── Test Helpers ───
  writeFile(
    dir,
    "src/test-helpers/factories.ts",
    `import type { User } from "../types/user.js";
import type { Product } from "../types/product.js";
import type { Order, OrderItem } from "../types/order.js";

let counter = 0;
function nextId(prefix: string): string {
  return \`\${prefix}_test_\${++counter}\`;
}

/** Create a test user with default values */
export function createTestUser(overrides: Partial<User> = {}): User {
  return {
    id: nextId("usr"),
    email: \`user\${counter}@test.com\`,
    passwordHash: "hashed",
    name: \`Test User \${counter}\`,
    role: "customer",
    createdAt: new Date(),
    ...overrides,
  };
}

/** Create a test product with default values */
export function createTestProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: nextId("prod"),
    name: \`Test Product \${counter}\`,
    description: "A test product",
    priceCents: 1999,
    currency: "USD",
    category: "test",
    inventory: 100,
    imageUrls: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Create a test order with default values */
export function createTestOrder(userId: string, overrides: Partial<Order> = {}): Order {
  return {
    id: nextId("ord"),
    userId,
    items: [createTestOrderItem()],
    totalCents: 1999,
    status: "pending",
    shippingAddress: {
      line1: "123 Test St",
      city: "Test City",
      state: "TS",
      postalCode: "12345",
      country: "US",
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Create a test order item */
export function createTestOrderItem(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    productId: nextId("prod"),
    productName: "Test Product",
    quantity: 1,
    unitPriceCents: 1999,
    ...overrides,
  };
}
`
  );

  writeFile(
    dir,
    "src/test-helpers/database.ts",
    `import { getDatabase, closeDatabase } from "../database/connection.js";
import { runMigrations } from "../database/migrations.js";

/** Set up a clean test database */
export async function setupTestDatabase(): Promise<void> {
  await runMigrations();
}

/** Tear down the test database */
export async function teardownTestDatabase(): Promise<void> {
  await closeDatabase();
}

/** Clear all data from the database (preserving schema) */
export async function clearTestData(): Promise<void> {
  const db = await getDatabase();
  await db.execute("DELETE FROM orders");
  await db.execute("DELETE FROM carts");
  await db.execute("DELETE FROM products");
  await db.execute("DELETE FROM users");
}
`
  );

  writeFile(
    dir,
    "src/test-helpers/mocks.ts",
    `/** Create a mock payment service that always succeeds */
export function createSuccessfulPaymentMock() {
  return {
    processPayment: async (amount: number, currency: string) => ({
      success: true,
      paymentIntentId: \`pi_mock_\${Date.now()}\`,
    }),
    refundPayment: async (paymentIntentId: string) => ({
      success: true,
      refundId: \`re_mock_\${Date.now()}\`,
    }),
  };
}

/** Create a mock payment service that always fails */
export function createFailingPaymentMock(reason = "Card declined") {
  return {
    processPayment: async (amount: number, currency: string) => ({
      success: false,
      error: reason,
    }),
    refundPayment: async (paymentIntentId: string) => ({
      success: false,
      error: "Refund failed",
    }),
  };
}

/** Create a mock notification service */
export function createNotificationMock() {
  const sent: Array<{ type: string; userId: string; email: string }> = [];
  return {
    sendNotification: async (payload: { type: string; userId: string; email: string }) => {
      sent.push(payload);
      return true;
    },
    getSent: () => sent,
    reset: () => { sent.length = 0; },
  };
}
`
  );

  // ─── Additional middleware ───
  writeFile(
    dir,
    "src/middleware/request-logger.ts",
    `import { info } from "../utils/logger.js";

/** Log incoming HTTP requests */
export function logRequest(method: string, path: string, statusCode: number, durationMs: number): void {
  info("HTTP request", {
    method,
    path,
    statusCode,
    durationMs,
  });
}

/** Create a request timer */
export function startTimer(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}
`
  );

  writeFile(
    dir,
    "src/middleware/sanitizer.ts",
    `/** Sanitize a string to prevent XSS */
export function sanitizeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Sanitize SQL input (basic, use parameterized queries in production) */
export function sanitizeSql(input: string): string {
  return input.replace(/'/g, "''");
}

/** Strip null bytes from input */
export function stripNullBytes(input: string): string {
  return input.replace(/\\0/g, "");
}

/** Validate and sanitize a URL */
export function sanitizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}
`
  );

  // ─── Additional routes ───
  writeFile(
    dir,
    "src/routes/admin-routes.ts",
    `import { requireAdmin } from "../middleware/auth.js";
import { getDashboardMetrics } from "../services/analytics-service.js";
import { handleError } from "../middleware/error-handler.js";
import { orderModel } from "../models/order-model.js";
import { userModel } from "../models/user-model.js";
import type { User } from "../types/user.js";

/** GET /admin/dashboard — get admin dashboard metrics */
export async function dashboardRoute(authHeader: string | undefined) {
  try {
    const auth = requireAdmin(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    return await getDashboardMetrics();
  } catch (error) {
    return handleError(error);
  }
}

/** GET /admin/users — list all users */
export async function listUsersRoute(authHeader: string | undefined) {
  try {
    const auth = requireAdmin(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    return await userModel.findAll<User>();
  } catch (error) {
    return handleError(error);
  }
}

/** POST /admin/users/:id/promote — promote user to admin */
export async function promoteUserRoute(authHeader: string | undefined, userId: string) {
  try {
    const auth = requireAdmin(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    await userModel.updateRole(userId, "admin");
    return { success: true };
  } catch (error) {
    return handleError(error);
  }
}

/** GET /admin/orders — list orders by status */
export async function listOrdersByStatusRoute(authHeader: string | undefined, status: string) {
  try {
    const auth = requireAdmin(authHeader);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    return await orderModel.findByStatus(status as any);
  } catch (error) {
    return handleError(error);
  }
}
`
  );

  writeFile(
    dir,
    "src/routes/webhook-routes.ts",
    `import { verifyWebhookSignature } from "../services/payment-service.js";
import { orderModel } from "../models/order-model.js";
import { sendNotification } from "../services/notification-service.js";
import { userModel } from "../models/user-model.js";
import { info, error as logError } from "../utils/logger.js";
import type { Order } from "../types/order.js";
import type { User } from "../types/user.js";

/** POST /webhooks/stripe — handle Stripe webhook events */
export async function handleStripeWebhook(payload: string, signature: string) {
  if (!verifyWebhookSignature(payload, signature)) {
    return { status: 400, body: { error: "Invalid signature" } };
  }

  const event = JSON.parse(payload);
  info("Stripe webhook received", { type: event.type });

  switch (event.type) {
    case "payment_intent.succeeded":
      await handlePaymentSuccess(event.data.object.metadata.orderId);
      break;
    case "payment_intent.payment_failed":
      await handlePaymentFailure(event.data.object.metadata.orderId, event.data.object.last_payment_error?.message);
      break;
    default:
      info("Unhandled webhook event", { type: event.type });
  }

  return { status: 200, body: { received: true } };
}

async function handlePaymentSuccess(orderId: string): Promise<void> {
  const order = await orderModel.findById<Order>(orderId);
  if (!order) return;

  await orderModel.updateStatus(orderId, "paid");
  const user = await userModel.findById<User>(order.userId);
  if (user) {
    await sendNotification({
      type: "order_confirmation",
      userId: user.id,
      email: user.email,
      data: { orderId, totalCents: order.totalCents },
    });
  }
}

async function handlePaymentFailure(orderId: string, reason?: string): Promise<void> {
  const order = await orderModel.findById<Order>(orderId);
  if (!order) return;

  const user = await userModel.findById<User>(order.userId);
  if (user) {
    await sendNotification({
      type: "payment_failed",
      userId: user.id,
      email: user.email,
      data: { orderId, reason: reason ?? "Unknown error" },
    });
  }
  logError("Payment failed for order", { orderId, reason });
}
`
  );

  writeFile(
    dir,
    "src/routes/health-routes.ts",
    `import { getDatabase } from "../database/connection.js";

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  database: boolean;
  timestamp: string;
}

const startTime = Date.now();

/** GET /health — application health check */
export async function healthCheck(): Promise<HealthStatus> {
  let dbHealthy = false;
  try {
    const db = await getDatabase();
    await db.query("SELECT 1");
    dbHealthy = true;
  } catch {
    dbHealthy = false;
  }

  return {
    status: dbHealthy ? "healthy" : "degraded",
    uptime: Date.now() - startTime,
    database: dbHealthy,
    timestamp: new Date().toISOString(),
  };
}

/** GET /ready — readiness probe */
export async function readinessCheck(): Promise<{ ready: boolean }> {
  const health = await healthCheck();
  return { ready: health.status !== "unhealthy" };
}
`
  );

  // ─── Additional Python file for multi-language coverage ───
  writeFile(
    dir,
    "scripts/generate_report.py",
    `"""Generate sales reports from order data."""

from datetime import datetime, timedelta
from typing import List, Dict, Optional


class SalesReport:
    """Generates and formats sales reports."""

    def __init__(self, orders: List[Dict]):
        self.orders = orders
        self.generated_at = datetime.now()

    def total_revenue(self) -> float:
        """Calculate total revenue from all paid orders."""
        return sum(
            order["total_cents"] / 100
            for order in self.orders
            if order["status"] == "paid"
        )

    def orders_by_status(self) -> Dict[str, int]:
        """Count orders grouped by status."""
        counts: Dict[str, int] = {}
        for order in self.orders:
            status = order["status"]
            counts[status] = counts.get(status, 0) + 1
        return counts

    def top_products(self, limit: int = 10) -> List[Dict]:
        """Get the most ordered products."""
        product_counts: Dict[str, int] = {}
        for order in self.orders:
            for item in order.get("items", []):
                pid = item["product_id"]
                product_counts[pid] = product_counts.get(pid, 0) + item["quantity"]
        sorted_products = sorted(product_counts.items(), key=lambda x: x[1], reverse=True)
        return [{"product_id": pid, "total_quantity": qty} for pid, qty in sorted_products[:limit]]

    def revenue_by_day(self, days: int = 30) -> Dict[str, float]:
        """Calculate daily revenue for the last N days."""
        cutoff = datetime.now() - timedelta(days=days)
        daily: Dict[str, float] = {}
        for order in self.orders:
            if order["status"] != "paid":
                continue
            created = datetime.fromisoformat(order["created_at"])
            if created < cutoff:
                continue
            day_key = created.strftime("%Y-%m-%d")
            daily[day_key] = daily.get(day_key, 0) + order["total_cents"] / 100
        return daily

    def format_summary(self) -> str:
        """Format a human-readable summary."""
        revenue = self.total_revenue()
        by_status = self.orders_by_status()
        return (
            f"Sales Report ({self.generated_at.strftime('%Y-%m-%d')})\\n"
            f"Total Revenue: \${revenue:,.2f}\\n"
            f"Total Orders: {len(self.orders)}\\n"
            f"By Status: {by_status}"
        )


def generate_weekly_report(orders: List[Dict]) -> str:
    """Generate a weekly sales report."""
    week_ago = datetime.now() - timedelta(days=7)
    recent = [o for o in orders if datetime.fromisoformat(o["created_at"]) > week_ago]
    report = SalesReport(recent)
    return report.format_summary()


def generate_monthly_report(orders: List[Dict]) -> str:
    """Generate a monthly sales report."""
    month_ago = datetime.now() - timedelta(days=30)
    recent = [o for o in orders if datetime.fromisoformat(o["created_at"]) > month_ago]
    report = SalesReport(recent)
    return report.format_summary()
`
  );

  writeFile(
    dir,
    "scripts/data_export.py",
    `"""Export data in various formats for analysis."""

import json
import csv
from typing import List, Dict, Optional
from io import StringIO


def export_to_csv(data: List[Dict], columns: Optional[List[str]] = None) -> str:
    """Export data to CSV format."""
    if not data:
        return ""

    if columns is None:
        columns = list(data[0].keys())

    output = StringIO()
    writer = csv.DictWriter(output, fieldnames=columns)
    writer.writeheader()
    for row in data:
        writer.writerow({k: row.get(k, "") for k in columns})

    return output.getvalue()


def export_to_json(data: List[Dict], pretty: bool = True) -> str:
    """Export data to JSON format."""
    indent = 2 if pretty else None
    return json.dumps(data, indent=indent, default=str)


def filter_by_date_range(
    data: List[Dict],
    date_field: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> List[Dict]:
    """Filter data by date range."""
    filtered = data
    if start_date:
        filtered = [d for d in filtered if d.get(date_field, "") >= start_date]
    if end_date:
        filtered = [d for d in filtered if d.get(date_field, "") <= end_date]
    return filtered


def aggregate_by_field(data: List[Dict], field: str) -> Dict[str, int]:
    """Aggregate data by a field, counting occurrences."""
    counts: Dict[str, int] = {}
    for row in data:
        value = str(row.get(field, "unknown"))
        counts[value] = counts.get(value, 0) + 1
    return counts
`
  );

  return { name: "large", fileCount: 48, approxLoc: 6000, dir };
}
