export interface BenchmarkPrompt {
  query: string;
  category:
    | "exact"
    | "concept"
    | "cross-cutting"
    | "debugging"
    | "architecture"
    | "refactoring";
  expectedChunks: string[];
}

// ─── Small Codebase: Auth Service ───

export const smallPrompts: BenchmarkPrompt[] = [
  // Exact name
  {
    query: "How does validateToken work?",
    category: "exact",
    expectedChunks: ["validateToken"],
  },
  {
    query: "What does createSession do?",
    category: "exact",
    expectedChunks: ["createSession"],
  },

  // Concept
  {
    query: "How is authentication handled?",
    category: "concept",
    expectedChunks: ["authenticateRequest", "validateToken", "requireRole"],
  },
  {
    query: "How are user credentials managed?",
    category: "concept",
    expectedChunks: ["createUser", "findUserByEmail"],
  },

  // Cross-cutting
  {
    query: "What happens when a token expires?",
    category: "cross-cutting",
    expectedChunks: ["validateToken", "getSession"],
  },

  // Debugging
  {
    query: "Why might sessions expire early?",
    category: "debugging",
    expectedChunks: ["getSession", "loadAuthConfig", "createSession"],
  },

  // Architecture
  {
    query: "Show me the request lifecycle",
    category: "architecture",
    expectedChunks: ["authenticateRequest", "requireRole", "validateToken"],
  },

  // Refactoring
  {
    query: "Where is the session store used?",
    category: "refactoring",
    expectedChunks: ["createSession", "getSession", "destroySession", "getUserSessions"],
  },
];

// ─── Medium Codebase: E-Commerce API ───

export const mediumPrompts: BenchmarkPrompt[] = [
  // Exact name
  {
    query: "How does processPayment work?",
    category: "exact",
    expectedChunks: ["processPayment"],
  },
  {
    query: "What does createOrder do?",
    category: "exact",
    expectedChunks: ["createOrder"],
  },

  // Concept
  {
    query: "How is authentication handled?",
    category: "concept",
    expectedChunks: ["extractAuth", "requireAuth", "requireAdmin"],
  },
  {
    query: "How does the shopping cart work?",
    category: "concept",
    expectedChunks: ["addToCart", "removeFromCart", "getCart", "getCartTotal"],
  },

  // Cross-cutting
  {
    query: "What happens when a payment fails?",
    category: "cross-cutting",
    expectedChunks: ["processPayment", "payOrder", "cancelOrder", "PaymentError"],
  },
  {
    query: "How are errors returned to the client?",
    category: "cross-cutting",
    expectedChunks: ["handleError", "AppError", "NotFoundError"],
  },

  // Debugging
  {
    query: "Why might an order fail to process?",
    category: "debugging",
    expectedChunks: ["createOrder", "processPayment", "decrementInventory"],
  },
  {
    query: "Why would a user get rate limited?",
    category: "debugging",
    expectedChunks: ["checkRateLimit", "registerRoute", "loginRoute"],
  },

  // Architecture
  {
    query: "Show me the request lifecycle",
    category: "architecture",
    expectedChunks: ["requireAuth", "validateRequired", "handleError"],
  },
  {
    query: "How is data validated before processing?",
    category: "architecture",
    expectedChunks: ["validateRequired", "validateEmail", "validatePrice", "validatePagination"],
  },

  // Refactoring
  {
    query: "Where is the database connection used?",
    category: "refactoring",
    expectedChunks: ["getDatabase", "closeDatabase"],
  },
  {
    query: "Which services depend on the product service?",
    category: "refactoring",
    expectedChunks: ["createOrder", "addToCart", "getCartTotal"],
  },
];

// ─── Large Codebase: Full-Stack Platform ───

export const largePrompts: BenchmarkPrompt[] = [
  // Exact name
  {
    query: "How does processPayment work?",
    category: "exact",
    expectedChunks: ["processPayment"],
  },
  {
    query: "What does the UserModel class do?",
    category: "exact",
    expectedChunks: ["UserModel"],
  },
  {
    query: "How does withRetry work?",
    category: "exact",
    expectedChunks: ["withRetry"],
  },

  // Concept
  {
    query: "How is authentication handled?",
    category: "concept",
    expectedChunks: ["extractAuth", "requireAuth", "requireAdmin"],
  },
  {
    query: "How does the notification system work?",
    category: "concept",
    expectedChunks: ["sendNotification", "broadcastToUser", "notifyOrderUpdate"],
  },
  {
    query: "How are background jobs processed?",
    category: "concept",
    expectedChunks: ["processJobs", "registerHandler", "enqueueJob"],
  },

  // Cross-cutting
  {
    query: "What happens when a payment fails?",
    category: "cross-cutting",
    expectedChunks: ["processPayment", "handlePaymentFailure", "sendNotification", "PaymentError"],
  },
  {
    query: "How do WebSocket events get broadcast?",
    category: "cross-cutting",
    expectedChunks: ["broadcastToUser", "broadcastToAll", "notifyOrderUpdate", "notifyInventoryChange"],
  },
  {
    query: "What cleanup runs automatically?",
    category: "cross-cutting",
    expectedChunks: ["cleanupExpiredSessions", "archiveOldOrders", "purgeOldAnalytics", "runAllCleanup"],
  },

  // Debugging
  {
    query: "Why might sessions expire early?",
    category: "debugging",
    expectedChunks: ["cleanupExpiredSessions", "pruneStaleConnections"],
  },
  {
    query: "Why would emails fail to send?",
    category: "debugging",
    expectedChunks: ["processEmailQueue", "deliverEmail", "enqueueEmail"],
  },
  {
    query: "What could cause inventory to go negative?",
    category: "debugging",
    expectedChunks: ["reserveInventory", "releaseInventory", "decrementInventory"],
  },

  // Architecture
  {
    query: "Show me the request lifecycle",
    category: "architecture",
    expectedChunks: ["requireAuth", "logRequest", "handleError", "sanitizeHtml"],
  },
  {
    query: "How is the database layer structured?",
    category: "architecture",
    expectedChunks: ["BaseModel", "getDatabase", "runMigrations"],
  },
  {
    query: "How does configuration management work?",
    category: "architecture",
    expectedChunks: ["getEnvironment", "getFeatureFlags", "getCorsConfig", "loadConfig"],
  },

  // Refactoring
  {
    query: "Where is the database connection used?",
    category: "refactoring",
    expectedChunks: ["getDatabase", "closeDatabase", "BaseModel"],
  },
  {
    query: "Which files import from the logger utility?",
    category: "refactoring",
    expectedChunks: ["info", "warn", "error"],
  },
  {
    query: "What uses the order model?",
    category: "refactoring",
    expectedChunks: ["orderModel", "processOrderJob", "handlePaymentSuccess"],
  },
];

export const promptsBySize = {
  small: smallPrompts,
  medium: mediumPrompts,
  large: largePrompts,
} as const;
