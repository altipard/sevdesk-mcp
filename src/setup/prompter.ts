/** Returned by a prompt the user cancelled (Ctrl-C, Esc). */
export const CANCELLED: unique symbol = Symbol("cancelled");
export type Answer<T> = T | typeof CANCELLED;

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

/** The prompts and messages of the interactive setup; tests script it. */
export interface Prompter {
  intro(title: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  note(lines: string, title?: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  multiselect<T>(options: {
    message: string;
    choices: Choice<T>[];
    initial: T[];
    required: boolean;
  }): Promise<Answer<T[]>>;
  select<T>(options: { message: string; choices: Choice<T>[]; initial: T }): Promise<Answer<T>>;
  confirm(options: { message: string; initial: boolean }): Promise<Answer<boolean>>;
  /** Hidden input; validate returns a problem (shown, then asked again) or undefined. */
  password(options: {
    message: string;
    validate: (value: string) => string | undefined;
  }): Promise<Answer<string>>;
  /** Shows `message` while `task` runs; Ctrl-C meanwhile cancels. */
  spin<T>(message: string, task: () => Promise<T>): Promise<Answer<T>>;
}

/** The clack implementation, loaded only for an interactive setup. */
export async function clackPrompter(): Promise<Prompter> {
  const p = await import("@clack/prompts");
  // clack returns its own cancel symbol in place of the value.
  const unwrap = <T>(value: unknown): Answer<T> => (p.isCancel(value) ? CANCELLED : (value as T));
  const options = <T>(choices: Choice<T>[]) =>
    choices.map((choice) => ({
      value: choice.value,
      label: choice.label,
      ...(choice.hint ? { hint: choice.hint } : {}),
    })) as Parameters<typeof p.select<T>>[0]["options"];
  return {
    intro: (title) => p.intro(title),
    outro: (message) => p.outro(message),
    cancel: (message) => p.cancel(message),
    note: (lines, title) => p.note(lines, title),
    info: (message) => p.log.info(message),
    success: (message) => p.log.success(message),
    warn: (message) => p.log.warn(message),
    error: (message) => p.log.error(message),
    multiselect: async ({ message, choices, initial, required }) =>
      unwrap<typeof initial>(
        await p.multiselect({
          message,
          options: options(choices),
          initialValues: initial,
          required,
        }),
      ),
    select: async ({ message, choices, initial }) =>
      unwrap<typeof initial>(
        await p.select({ message, options: options(choices), initialValue: initial }),
      ),
    confirm: async ({ message, initial }) =>
      unwrap<boolean>(await p.confirm({ message, initialValue: initial })),
    password: async ({ message, validate }) =>
      unwrap<string>(await p.password({ message, validate: (value) => validate(value ?? "") })),
    spin: async <T>(message: string, task: () => Promise<T>): Promise<Answer<T>> => {
      // A plain status line instead of clack's spinner: that one ends the process with exit
      // code 0 on Ctrl-C. Between prompts the terminal is put in raw mode here, so Ctrl-C
      // arrives as a byte and ends the wait as a cancel; SIGINT (no terminal) does the same.
      let cancel = () => {};
      const cancelled = new Promise<typeof CANCELLED>((resolve) => {
        cancel = () => resolve(CANCELLED);
      });
      const stdin = process.stdin;
      const onData = (chunk: Buffer | string) => {
        if (String(chunk).includes("\u0003")) cancel();
      };
      const onSignal = () => cancel();
      const raw = stdin.isTTY ? stdin.isRaw : false;
      if (stdin.isTTY) {
        stdin.setRawMode(true);
        stdin.on("data", onData);
        stdin.resume();
      }
      process.on("SIGINT", onSignal);
      p.log.step(`${message}...`);
      try {
        return await Promise.race([task(), cancelled]);
      } finally {
        process.off("SIGINT", onSignal);
        if (stdin.isTTY) {
          stdin.off("data", onData);
          stdin.setRawMode(raw);
          stdin.pause();
        }
      }
    },
  };
}
