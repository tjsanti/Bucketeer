// Theme choice. Loaded as a classic script in <head>, after the stylesheet, so a
// saved choice applies before first paint. With no saved choice the page
// follows prefers-color-scheme through CSS alone; this only adds the override.
(() => {
  type Theme = "light" | "dark";
  const storageKey = "bucketeer-theme";
  const root = document.documentElement;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

  function savedTheme(): Theme | undefined {
    try {
      const value = window.localStorage.getItem(storageKey);
      return value === "light" || value === "dark" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  function currentTheme(): Theme {
    const chosen = root.dataset.theme;
    if (chosen === "light" || chosen === "dark") return chosen;
    return systemDark.matches ? "dark" : "light";
  }

  function sync(): void {
    document.getElementById("theme-toggle")?.setAttribute("aria-pressed", String(currentTheme() === "dark"));
    const background = getComputedStyle(root).getPropertyValue("--bg").trim();
    if (!background) return;
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = background;
  }

  const saved = savedTheme();
  if (saved) root.dataset.theme = saved;
  systemDark.addEventListener("change", sync);
  document.addEventListener("DOMContentLoaded", () => {
    sync();
    document.getElementById("theme-toggle")?.addEventListener("click", () => {
      const next: Theme = currentTheme() === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        // Storage can be unavailable (private mode, blocked site data); the choice lasts for this page.
      }
      sync();
    });
  });
})();
