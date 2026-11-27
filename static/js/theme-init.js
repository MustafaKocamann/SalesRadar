/*
 * Applies the persisted appearance before first paint.
 * Loaded synchronously in <head> so the document never flashes a wrong theme.
 * Deliberately dependency-free and defensive: a corrupt storage value must not
 * break the application shell.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "salesradar.settings.v1";
  var root = document.documentElement;
  var settings = {};

  try {
    settings = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch (error) {
    settings = {};
  }

  var prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  var preference = settings.theme === "light" || settings.theme === "dark" ? settings.theme : "system";
  var resolved = preference === "system" ? (prefersDark ? "dark" : "light") : preference;

  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-theme-preference", preference);
  root.setAttribute("data-density", settings.density === "compact" ? "compact" : "comfortable");
  root.setAttribute(
    "data-motion",
    settings.motion === "reduced" || (!settings.motion && window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      ? "reduced"
      : "full"
  );

  var themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.setAttribute("content", resolved === "dark" ? "#0a0c0e" : "#f6f7f8");
  }
})();
