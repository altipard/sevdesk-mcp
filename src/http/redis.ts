import { createClient } from "redis";
import type { Logger } from "../logger.js";
import { type RedisCommands, RedisNonceStore } from "../policy/redis-nonce-store.js";

/**
 * Upper bound for one command; a slow Redis must not hold a tool call.
 * Passed to node-redis and enforced again by the store, because the client
 * option does not cover commands already sent. No socketTimeout: it would
 * also drop healthy idle connections.
 */
export const REDIS_COMMAND_TIMEOUT_MS = 2000;
export const REDIS_CONNECT_TIMEOUT_MS = 5000;
/** Upper bound for closing the connection on shutdown. */
export const REDIS_CLOSE_TIMEOUT_MS = 1000;
/** Failed connection attempts at startup before the server gives up. */
export const REDIS_STARTUP_RETRIES = 5;

export interface RedisNonceConnection {
  readonly store: RedisNonceStore;
  close(): Promise<void>;
}

export type ConnectNonceStore = (url: string, logger: Logger) => Promise<RedisNonceConnection>;

/**
 * Connects to Redis and returns the shared nonce store.
 *
 * Startup fails if Redis cannot be reached after a few attempts, so a wrong
 * URL or password shows up at once instead of at the first confirmation.
 * It also writes the sentinel key that detects later data loss.
 * Once connected, the client reconnects in the background without limit;
 * while it is disconnected, commands are not queued but fail at once, and
 * the store rejects: confirmations fail closed, reading tools keep working.
 */
export const connectRedisNonceStore: ConnectNonceStore = async (url, logger) => {
  let connected = false;
  const client = createClient({
    url,
    disableOfflineQueue: true,
    commandOptions: { timeout: REDIS_COMMAND_TIMEOUT_MS },
    socket: {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) => {
        if (!connected && retries >= REDIS_STARTUP_RETRIES) {
          return new Error("Redis is not reachable");
        }
        return Math.min(100 * 2 ** retries, 2000);
      },
    },
  });
  // Without a listener, a socket error would crash the process. The URL and
  // its password are redacted by the logger.
  client.on("error", (error: unknown) => logger.warn("redis connection error", { error }));
  client.on("ready", () => logger.info("redis ready"));

  await client.connect();
  connected = true;

  const store = new RedisNonceStore(client as unknown as RedisCommands, {
    operationTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
    onStateLost: () =>
      logger.error("redis lost its data: confirmations refused until restart", {
        hint: "check appendonly yes and maxmemory-policy noeviction, then restart the server",
      }),
  });
  const close = async () => {
    if (!client.isOpen) return;
    // QUIT waits for pending replies; a Redis that stopped answering must
    // not hold the shutdown.
    let timer: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      client.close().then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), REDIS_CLOSE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!closed) client.destroy();
  };
  try {
    await store.initialize();
  } catch (error) {
    await close();
    throw error;
  }
  await checkEvictionPolicy(() => client.configGet("maxmemory-policy"), logger);
  return { store, close };
};

/**
 * Warns when Redis may evict keys: an evicted nonce makes a used
 * confirmation valid again, and the sentinel cannot see a partial loss.
 * Only a warning, never a startup failure: managed Redis services often
 * forbid CONFIG, and the policy can be right without being readable.
 */
export async function checkEvictionPolicy(
  read: () => Promise<unknown>,
  logger: Logger,
  timeoutMs = REDIS_COMMAND_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let policy: unknown;
  try {
    const reply = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("CONFIG GET timed out")), timeoutMs);
      }),
    ]);
    policy = (reply as Record<string, unknown> | null)?.["maxmemory-policy"];
  } catch (error) {
    logger.warn("could not read the redis maxmemory-policy; make sure it is noeviction", {
      error,
    });
    return;
  } finally {
    clearTimeout(timer);
  }
  if (policy === "noeviction") return;
  logger.warn("redis maxmemory-policy is not noeviction: used nonces can be evicted", {
    policy: typeof policy === "string" ? policy : "unknown",
    hint: "set maxmemory-policy noeviction on a Redis of its own",
  });
}
