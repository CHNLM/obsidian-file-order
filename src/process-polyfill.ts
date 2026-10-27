declare global {
  interface Window {
    process?: any;
  }
}

if (window.process === undefined) {
  // Minimal process polyfill for Obsidian mobile (and any renderer that lacks
  // window.process). iOS is detected from the user agent; every other
  // environment falls back to "android".
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
