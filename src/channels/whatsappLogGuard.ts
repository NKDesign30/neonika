type TConsoleMethodName = "info" | "warn" | "error";
type TConsoleMethod = (...values: readonly unknown[]) => void;

const sensitiveLibsignalPrefixes: Readonly<Record<TConsoleMethodName, readonly string[]>> = {
  info: ["Closing session:", "Opening session:", "Removing old closed session:"],
  warn: ["Session already closed"],
  error: ["V1 session storage migration error:"]
};

let activeGuards = 0;
let originalMethods: Readonly<Record<TConsoleMethodName, TConsoleMethod>> | undefined;

/**
 * libsignal 6 logs session objects and migration identifiers through the
 * global console instead of the Baileys logger. Suppress only those exact
 * sensitive lines and restore the process console when the final socket stops.
 */
export function installNeonWhatsAppLibsignalLogGuard(): () => void {
  if (activeGuards === 0) {
    const originals = {
      info: console.info.bind(console) as TConsoleMethod,
      warn: console.warn.bind(console) as TConsoleMethod,
      error: console.error.bind(console) as TConsoleMethod
    };
    originalMethods = originals;
    for (const methodName of Object.keys(sensitiveLibsignalPrefixes) as TConsoleMethodName[]) {
      const original = originals[methodName];
      console[methodName] = ((...values: readonly unknown[]): void => {
        if (isSensitiveLibsignalCall(methodName, values)) {
          return;
        }
        original(...values);
      }) as typeof console[typeof methodName];
    }
  }
  activeGuards += 1;
  let restored = false;

  return () => {
    if (restored) {
      return;
    }
    restored = true;
    activeGuards = Math.max(0, activeGuards - 1);
    if (activeGuards !== 0 || originalMethods === undefined) {
      return;
    }
    console.info = originalMethods.info as typeof console.info;
    console.warn = originalMethods.warn as typeof console.warn;
    console.error = originalMethods.error as typeof console.error;
    originalMethods = undefined;
  };
}

function isSensitiveLibsignalCall(
  methodName: TConsoleMethodName,
  values: readonly unknown[]
): boolean {
  const first = values[0];
  return (
    typeof first === "string" &&
    sensitiveLibsignalPrefixes[methodName].some((prefix) => first.startsWith(prefix)) &&
    (methodName === "error" ||
      values.slice(1).some((value) => typeof value === "object" && value !== null))
  );
}
