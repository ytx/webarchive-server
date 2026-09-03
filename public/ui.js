// Shared header controls (settings link, language and theme toggles) and the
// close-tab confirmation. Pages import this module and call initUi().
import { applyTranslations, getLang, setLang, t } from "./i18n.js";

const THEME_KEY = "webarchive.theme";

export const ICONS = {
  // Cog: a ring with eight square teeth and a hollow hub (not a sun: no rays).
  settings: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M10.3 5.0 L10.7 2.6 L13.3 2.6 L13.7 5.0 L15.8 5.9 L17.8 4.4 L19.6 6.2 L18.1 8.2 L19.0 10.3 L21.4 10.7 L21.4 13.3 L19.0 13.7 L18.1 15.8 L19.6 17.8 L17.8 19.6 L15.8 18.1 L13.7 19.0 L13.3 21.4 L10.7 21.4 L10.3 19.0 L8.2 18.1 L6.2 19.6 L4.4 17.8 L5.9 15.8 L5.0 13.7 L2.6 13.3 L2.6 10.7 L5.0 10.3 L5.9 8.2 L4.4 6.2 L6.2 4.4 L8.2 5.9z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  language: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>'
};

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

export function currentTheme() {
  return storedTheme() ?? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // storage unavailable: the choice just won't persist
  }
}

// Confirm before the tab is closed (or reloaded), but not when following a
// link inside the app: getting back to the list after an accidental close is
// a chore, whereas in-app navigation is what the links are for. The browser
// can't tell the two apart, so remember that a same-origin navigation was
// just started and let that one through.
let navigating = false;
let navigatingTimer = null;

export function allowNavigation() {
  navigating = true;
  clearTimeout(navigatingTimer);
  // If the navigation is cancelled (e.g. by another beforeunload dialog) the
  // page lives on; forget the exemption after a moment so a later close still
  // asks.
  navigatingTimer = setTimeout(() => { navigating = false; }, 2000);
}

function installCloseGuard() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link || link.target === "_blank" || link.hasAttribute("download")) {
      return;
    }
    if (new URL(link.href, location.href).origin === location.origin) {
      allowNavigation();
    }
  });
  document.addEventListener("submit", () => allowNavigation());
  window.addEventListener("beforeunload", (event) => {
    if (navigating) {
      return;
    }
    event.preventDefault();
    event.returnValue = t("unload.confirm");
  });
  window.addEventListener("pageshow", () => { navigating = false; });
}

function iconButton(icon, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn";
  button.innerHTML = icon;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", onClick);
  return button;
}

function renderControls(header, { settingsLink }) {
  const box = document.createElement("div");
  box.className = "controls";
  // Order: theme, language, settings.
  const theme = iconButton("", "", () => {
    setTheme(currentTheme() === "dark" ? "light" : "dark");
    paintThemeButton();
  });
  function paintThemeButton() {
    const dark = currentTheme() === "dark";
    theme.innerHTML = dark ? ICONS.sun : ICONS.moon;
    theme.title = t(dark ? "nav.theme.light" : "nav.theme.dark");
    theme.setAttribute("aria-label", theme.title);
  }
  paintThemeButton();
  box.append(theme);
  const lang = iconButton(ICONS.language, t("nav.language"), () => {
    setLang(getLang() === "ja" ? "en" : "ja");
    allowNavigation();
    location.reload();
  });
  lang.append(Object.assign(document.createElement("span"), { className: "lang-label", textContent: getLang().toUpperCase() }));
  box.append(lang);
  if (settingsLink) {
    const link = document.createElement("a");
    link.className = "icon-btn";
    link.href = "/settings";
    link.innerHTML = ICONS.settings;
    link.title = t("nav.settings");
    link.setAttribute("aria-label", t("nav.settings"));
    box.append(link);
  }
  header.append(box);
}

export function initUi({ settingsLink = true } = {}) {
  document.documentElement.dataset.theme = currentTheme();
  applyTranslations();
  const header = document.querySelector("header.top");
  if (header) {
    renderControls(header, { settingsLink });
  }
  installCloseGuard();
}
