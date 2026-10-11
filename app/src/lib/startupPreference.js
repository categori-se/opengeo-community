const PREFERENCE_KEY = "opengeo.studio.welcome.preference";
const VISIT_KEY = "opengeo.studio.welcome.visit";
export const WELCOME_IDLE_MS = 30 * 60 * 1000;
export const WELCOME_RETURN_MS = 24 * 60 * 60 * 1000;
export const WELCOME_CHOICES = Object.freeze([
  {value: "daily", label: "After a day away"},
  {value: "session", label: "New session or after 30 minutes away"},
  {value: "always", label: "Every time I open Studio"},
  {value: "manual", label: "Only when I open it from Settings"}
]);

export function createStartupPreference({preferences, session, now = () => Date.now()} = {}) {
  const read = (storage, key) => {try {return storage?.getItem(key);} catch {return null;}};
  const write = (storage, key, value) => {try {storage?.setItem(key, value);} catch {/* Storage can be unavailable in private browsing. */}};
  const mode = () => {
    const stored = read(preferences, PREFERENCE_KEY);
    return WELCOME_CHOICES.some(({value}) => value === stored) ? stored : "daily";
  };
  return {
    mode,
    setMode(value) {
      if (!WELCOME_CHOICES.some((choice) => choice.value === value)) throw new TypeError("Unknown welcome preference");
      write(preferences, PREFERENCE_KEY, value);
    },
    shouldShow() {
      if (mode() === "manual") return false;
      if (mode() === "always") return true;
      const stored = mode() === "session" ? read(session, VISIT_KEY) : (read(preferences, VISIT_KEY) ?? read(session, VISIT_KEY));
      const last = Number(stored);
      const elapsed = now() - last;
      return stored == null || !Number.isFinite(last) || elapsed < 0 || elapsed >= (mode() === "session" ? WELCOME_IDLE_MS : WELCOME_RETURN_MS);
    },
    remember() {
      const value = String(now());
      write(session, VISIT_KEY, value);
      write(preferences, VISIT_KEY, value);
    }
  };
}

export function browserStartupPreference() {
  let preferences, session;
  try {preferences = globalThis.localStorage;} catch {/* Use defaults. */}
  try {session = globalThis.sessionStorage;} catch {/* Use defaults. */}
  return createStartupPreference({preferences, session});
}
