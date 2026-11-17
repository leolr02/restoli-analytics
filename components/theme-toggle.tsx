"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

const THEME_STORAGE_KEY = "restoli-theme";

const THEMES = {
  light: "restoli-light",
  dark: "restoli-dark",
} as const;

type Theme = (typeof THEMES)[keyof typeof THEMES];

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(THEMES.light);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    const initialTheme =
      savedTheme === THEMES.dark || savedTheme === "dark"
        ? THEMES.dark
        : THEMES.light;

    document.documentElement.dataset.theme = initialTheme;
    setTheme(initialTheme);
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === THEMES.light ? THEMES.dark : THEMES.light;

    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    setTheme(nextTheme);
  };

  const isDark = theme === THEMES.dark;

  return (
    <button
      type="button"
      className={`btn btn-ghost btn-circle swap swap-rotate duration-[1.5s] ${isDark ? "swap-active" : ""}`}
      onClick={toggleTheme}
      aria-label={`Cambiar a tema ${isDark ? "claro" : "oscuro"}`}
      aria-pressed={isDark}
    >
      <Sun className="swap-off size-5" aria-hidden="true" />
      <Moon className="swap-on size-5" aria-hidden="true" />
    </button>
  );
}