// Preloaded into the built binary by test/protocol/stdio.test.ts. Once the
// server reports that it started, it prints which secret variables are
// still in process.env, by name only. With PROBE_KEYCHAIN_TOKEN set it
// stands in for the keychain tool, so no test reads a real keychain.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const NAMES = ["SEVDESK_API_TOKEN", "SEVDESK_CONFIRM_SECRET"];
/** Secret names the keychain tool was started with, if it was started. */
let keychainEnv;

const keychainToken = process.env.PROBE_KEYCHAIN_TOKEN;
delete process.env.PROBE_KEYCHAIN_TOKEN;
if (keychainToken !== undefined) {
  childProcess.execFile = (_file, _args, options, callback) => {
    keychainEnv = NAMES.filter((name) => Object.hasOwn(options?.env ?? process.env, name));
    queueMicrotask(() => callback(null, `${keychainToken}\n`, ""));
    return {};
  };
  syncBuiltinESMExports();
}

const write = process.stderr.write.bind(process.stderr);
let reported = false;
process.stderr.write = (chunk, ...rest) => {
  const result = write(chunk, ...rest);
  if (!reported && String(chunk).includes('"msg":"sevdesk-mcp started"')) {
    reported = true;
    const present = NAMES.filter((name) => Object.hasOwn(process.env, name));
    write(`env-probe ${JSON.stringify({ present, keychainEnv })}\n`);
  }
  return result;
};
