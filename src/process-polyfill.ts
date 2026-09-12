declare global {
  interface Window {
    process?: any;
  }
}

if (window.process === undefined) {
  // Simple process polyfill for Obsidian mobile. Detect the actual
  // platform instead of hard-coding "android".
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const platform = /iPhone|iPad|iPod/i.test(userAgent) ? "ios" : "android";

  window.process = {
    env: {
      // "production" is a sane default for Obsidian's runtime; React's
      // production bundle does not read this anyway.
      NODE_ENV: "production",
    },
    platform,
    version: "",
    nextTick: (fn: Function) => setTimeout(fn, 0),
  };
}

export {};
