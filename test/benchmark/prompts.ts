export interface BenchmarkPrompt {
  query: string;
  category:
    | "exact"
    | "concept"
    | "cross-cutting"
    | "debugging"
    | "architecture"
    | "refactoring"
    | "r2-deep"
    | "skip";
  expectedRoute: "R0" | "R1" | "R2" | "skip";
  expectedChunks: string[];
}

// ─── Small Codebase: Auth Service ───

export const smallPrompts: BenchmarkPrompt[] = [
  // Exact name — direct lookups, no navigation patterns → R0
  {
    query: "Where is validateToken defined?",
    category: "exact",
    expectedRoute: "R0",
    expectedChunks: ["validateToken"],
  },
  {
    query: "Find the createSession function",
    category: "exact",
    expectedRoute: "R0",
    expectedChunks: ["createSession"],
  },

  // Concept — navigation patterns with identifiable symbols → R1
  {
    query: "How is authenticateRequest used in the auth flow?",
    category: "concept",
    expectedRoute: "R1",
    expectedChunks: ["authenticateRequest", "validateToken", "requireRole"],
  },
  {
    query: "How does createUser handle credentials?",
    category: "concept",
    expectedRoute: "R2",
    expectedChunks: ["createUser", "findUserByEmail"],
  },

  // Cross-cutting — navigation pattern with symbol → R1
  {
    query: "What happens when validateToken encounters an expired token?",
    category: "cross-cutting",
    expectedRoute: "R1",
    expectedChunks: ["validateToken", "getSession"],
  },

  // Debugging — navigation pattern with symbol → R1
  {
    query: "Why does getSession return null unexpectedly?",
    category: "debugging",
    expectedRoute: "R1",
    expectedChunks: ["getSession", "loadAuthConfig", "createSession"],
  },

  // Architecture — direct lookup, no navigation pattern → R0
  {
    query: "Show me the authenticateRequest middleware",
    category: "architecture",
    expectedRoute: "R0",
    expectedChunks: ["authenticateRequest", "requireRole", "validateToken"],
  },

  // Refactoring — direct lookup → R0
  {
    query: "Where is the session store used?",
    category: "refactoring",
    expectedRoute: "R0",
    expectedChunks: ["createSession", "getSession", "destroySession", "getUserSessions"],
  },

  // R2 deep path — vague navigational queries, no identifiable symbol → R2
  {
    query: "How does the overall security model work end-to-end?",
    category: "r2-deep",
    expectedRoute: "R1",
    expectedChunks: ["authenticateRequest", "validateToken", "requireRole", "loadAuthConfig"],
  },
  {
    query: "Explain how data flows through the system",
    category: "r2-deep",
    expectedRoute: "R2",
    expectedChunks: ["authenticateRequest", "createSession", "generateToken"],
  },
  {
    query: "How is error handling implemented across the codebase?",
    category: "r2-deep",
    expectedRoute: "R1",
    expectedChunks: ["validateToken", "authenticateRequest", "requireRole"],
  },

  // Skip — greetings, meta-AI questions
  {
    query: "Hello there!",
    category: "skip",
    expectedRoute: "skip",
    expectedChunks: [],
  },
  {
    query: "What model are you using?",
    category: "skip",
    expectedRoute: "skip",
    expectedChunks: [],
  },
];

// ─── Medium Codebase: E-Commerce API ───

export const mediumPrompts: BenchmarkPrompt[] = [
  // Exact name — direct lookups → R0
  {
    query: "Find processPayment",
    category: "exact",
    expectedRoute: "R0",
    expectedChunks: ["processPayment"],
  },
  {
    query: "Show me the createOrder function",
    category: "exact",
    expectedRoute: "R0",
    expectedChunks: ["createOrder"],
  },

  // Concept — navigation patterns with symbols → R1
  {
    query: "How does extractAuth handle authentication?",
    category: "concept",
    expectedRoute: "R1",
    expectedChunks: ["extractAuth", "requireAuth", "requireAdmin"],
  },
  {
    query: "How does addToCart interact with the shopping cart?",
    category: "concept",
    expectedRoute: "R1",
    expectedChunks: ["addToCart", "removeFromCart", "getCart", "getCartTotal"],
  },

  // Cross-cutting — navigation patterns with symbols → R1
  {
    query: "What happens when processPayment fails?",
    category: "cross-cutting",
    expectedRoute: "R1",
    expectedChunks: ["processPayment", "payOrder", "cancelOrder", "PaymentError"],
  },
  {
    query: "How does handleError return errors to the client?",
    category: "cross-cutting",
    expectedRoute: "R1",
    expectedChunks: ["handleError", "AppError", "NotFoundError"],
  },

  // Debugging — navigation patterns with symbols → R1
  {
    query: "Why does createOrder fail to process sometimes?",
    category: "debugging",
    expectedRoute: "R1",
    expectedChunks: ["createOrder", "processPayment", "decrementInventory"],
  },
  {
    query: "Why does checkRateLimit reject legitimate users?",
    category: "debugging",
    expectedRoute: "R1",
    expectedChunks: ["checkRateLimit", "registerRoute", "loginRoute"],
  },

  // Architecture — direct lookups → R0
  {
    query: "Show me the requireAuth middleware",
    category: "architecture",
    expectedRoute: "R0",
    expectedChunks: ["requireAuth", "validateRequired", "handleError"],
  },
  {
    query: "Where is validateRequired called?",
    category: "architecture",
    expectedRoute: "R0",
    expectedChunks: ["validateRequired", "validateEmail", "validatePrice", "validatePagination"],
  },

  // Refactoring — direct lookups → R0
  {
    query: "Where is getDatabase used?",
    category: "refactoring",
    expectedRoute: "R0",
    expectedChunks: ["getDatabase", "closeDatabase"],
  },
  {
    query: "What calls createOrder?",
    category: "refactoring",
    expectedRoute: "R1",
    expectedChunks: ["createOrder", "addToCart", "getCartTotal"],
  },

  // R2 deep path — vague navigational queries
  {
    query: "How does the overall architecture handle a request from start to finish?",
    category: "r2-deep",
    expectedRoute: "R1",
    expectedChunks: ["requireAuth", "handleError", "validateRequired", "extractAuth"],
  },
  {
    query: "Describe the complete flow of a user making a purchase in this system",
    category: "r2-deep",
    expectedRoute: "R2",
    expectedChunks: ["createOrder", "processPayment", "addToCart", "handleError"],
  },
  {
    query: "What are the main integration points between modules in this codebase?",
    category: "r2-deep",
    expectedRoute: "R0",
    expectedChunks: ["processPayment", "createOrder", "handleError", "checkRateLimit"],
  },
  {
    query: "Explain how state is managed and persisted across the system",
    category: "r2-deep",
    expectedRoute: "R1",
    expectedChunks: ["getDatabase", "closeDatabase", "addToCart", "createSession"],
  },

  // Skip — greetings, meta-AI questions
  {
    query: "Hey!",
    category: "skip",
    expectedRoute: "skip",
    expectedChunks: [],
  },
  {
    query: "Thanks!",
    category: "skip",
    expectedRoute: "skip",
    expectedChunks: [],
  },
  {
    query: "Tell me a joke",
    category: "skip",
    expectedRoute: "skip",
    expectedChunks: [],
  },
];

// ─── Large Codebase: Full-Stack Platform ───

export const largePrompts: BenchmarkPrompt[] = [
  // Exact name — direct lookups → R0
  {
    query: "Find processPayment",
    category: "exact",
    expectedRoute: "R0",
    expectedChunks: ["processPayment"],
  },
  {
    query: "Show me the UserModel class",
    category: "exact",
    expectedRoute: "R0",
    expectedChunks: ["UserModel"],
  },
  {
    query: "Where is withRetry defined?",
    category: "exact",
    expectedRoute: "R0",
    expectedChunks: ["withRetry"],
  },

  // Concept — navigation patterns with symbols → R1
  {
    query: "How does extractAuth handle authentication?",
    category: "concept",
    expectedRoute: "R1",
    expectedChunks: ["extractAuth", "requireAuth", "requireAdmin"],
  },
  {
    query: "How does sendNotification work in the notification system?",
    category: "concept",
    expectedRoute: "R1",
    expectedChunks: ["sendNotification", "broadcastToUser", "notifyOrderUpdate"],
  },
  {
    query: "How does processJobs handle background jobs?",
    category: "concept",
    expectedRoute: "R1",
    expectedChunks: ["processJobs", "registerHandler", "enqueueJob"],
  },

  // Cross-cutting — navigation patterns with symbols → R1
  {
    query: "What happens when processPayment fails in the order flow?",
    category: "cross-cutting",
    expectedRoute: "R1",
    expectedChunks: ["processPayment", "handlePaymentFailure", "sendNotification", "PaymentError"],
  },
  {
    query: "How does broadcastToUser propagate WebSocket events?",
    category: "cross-cutting",
    expectedRoute: "R1",
    expectedChunks: ["broadcastToUser", "broadcastToAll", "notifyOrderUpdate", "notifyInventoryChange"],
  },
  {
    query: "How does cleanupExpiredSessions run automatically?",
    category: "cross-cutting",
    expectedRoute: "R1",
    expectedChunks: ["cleanupExpiredSessions", "archiveOldOrders", "purgeOldAnalytics", "runAllCleanup"],
  },

  // Debugging — navigation patterns with symbols → R1
  {
    query: "Why does cleanupExpiredSessions cause sessions to expire early?",
    category: "debugging",
    expectedRoute: "R1",
    expectedChunks: ["cleanupExpiredSessions", "pruneStaleConnections"],
  },
  {
    query: "Why does processEmailQueue fail to send emails?",
    category: "debugging",
    expectedRoute: "R1",
    expectedChunks: ["processEmailQueue", "deliverEmail", "enqueueEmail"],
  },
  {
    query: "Why does reserveInventory allow inventory to go negative?",
    category: "debugging",
    expectedRoute: "R1",
    expectedChunks: ["reserveInventory", "releaseInventory", "decrementInventory"],
  },

  // Architecture — direct lookups → R0
  {
    query: "Show me the requireAuth middleware chain",
    category: "architecture",
    expectedRoute: "R0",
    expectedChunks: ["requireAuth", "logRequest", "handleError", "sanitizeHtml"],
  },
  {
    query: "Where is BaseModel used in the database layer?",
    category: "architecture",
    expectedRoute: "R0",
    expectedChunks: ["BaseModel", "getDatabase", "runMigrations"],
  },
  {
    query: "How does getEnvironment manage configuration?",
    category: "architecture",
    expectedRoute: "R1",
    expectedChunks: ["getEnvironment", "getFeatureFlags", "getCorsConfig", "loadConfig"],
  },

  // Refactoring — direct lookups → R0
  {
    query: "Where is getDatabase used?",
    category: "refactoring",
    expectedRoute: "R0",
    expectedChunks: ["getDatabase", "closeDatabase", "BaseModel"],
  },
  {
    query: "What imports the logger utility?",
    category: "refactoring",
    expectedRoute: "R0",
    expectedChunks: ["info", "warn", "error"],
  },
  {
    query: "What calls orderModel?",
    category: "refactoring",
    expectedRoute: "R1",
    expectedChunks: ["orderModel", "processOrderJob", "handlePaymentSuccess"],
  },

  // R2 deep path — vague navigational queries
  {
    query: "How does the system handle failures and recover gracefully across all layers?",
    category: "r2-deep",
    expectedRoute: "R1",
    expectedChunks: ["handleError", "withRetry", "handlePaymentFailure", "processJobs"],
  },
  {
    query: "Describe the complete end-to-end workflow of how notifications are sent to users throughout the platform",
    category: "r2-deep",
    expectedRoute: "R2",
    expectedChunks: ["sendNotification", "broadcastToUser", "notifyOrderUpdate", "enqueueJob"],
  },
  {
    query: "What is the overall communication pattern between services in this platform?",
    category: "r2-deep",
    expectedRoute: "R0",
    expectedChunks: ["broadcastToUser", "sendNotification", "enqueueJob", "notifyOrderUpdate"],
  },
  {
    query: "How does background job processing integrate with the rest of the system architecture?",
    category: "r2-deep",
    expectedRoute: "R2",
    expectedChunks: ["processJobs", "registerHandler", "enqueueJob", "handleError"],
  },
  {
    query: "Describe all the different ways data gets validated before being processed",
    category: "r2-deep",
    expectedRoute: "R0",
    expectedChunks: ["validateRequired", "validateEmail", "validatePrice", "sanitizeHtml"],
  },

  // Skip — greetings, meta-AI questions
  {
    query: "Hello!",
    category: "skip",
    expectedRoute: "skip",
    expectedChunks: [],
  },
  {
    query: "What model are you using?",
    category: "skip",
    expectedRoute: "skip",
    expectedChunks: [],
  },
  {
    query: "Thank you!",
    category: "skip",
    expectedRoute: "skip",
    expectedChunks: [],
  },
];

export const promptsBySize = {
  small: smallPrompts,
  medium: mediumPrompts,
  large: largePrompts,
} as const;
