import { createClient } from "redis";
import type { Logger } from "../logger.js";
import { type RedisCommands, RedisNonceStore } from "../policy/redis-nonce-store.js";

/** Upper bound for one command; a slow Redis must not hold a tool call. */
export const REDIS_COMMAND_TIMEOUT_MS = 2000;
export const REDIS_CONNECT_TIMEOUT_MS = 5000;
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

  return {
    store: new RedisNonceStore(client as unknown as RedisCommands),
    close: async () => {
      if (!client.isOpen) return;
      try {
        await client.close();
      } catch {
        client.destroy();
      }
    },
  };
};
