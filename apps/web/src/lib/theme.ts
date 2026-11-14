const KEY = "herdr-web.theme"

/**
 * Runs in <head> before the first paint, so the page never flashes the wrong theme: the saved
 * choice if there is one, else the system's. Kept as a string because it is inlined by the layout.
 */
export const themeScript = `try{var t=localStorage.getItem(${JSON.stringify(KEY)});var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}`

export function isDark(): boolean {
  return document.documentElement.classList.contains("dark")
}

/** Flip dark and light and remember it on this device. */
export function toggleTheme(): void {
  const dark = !isDark()
  document.documentElement.classList.toggle("dark", dark)
  try {
    localStorage.setItem(KEY, dark ? "dark" : "light")
  } catch {
    // blocked storage: the choice holds until the page closes
  }
}

/** Follow the system while the person has not chosen. Returns the cleanup. */
export function followSystem(): () => void {
  const query = matchMedia("(prefers-color-scheme: dark)")
  const onChange = () => {
    try {
      if (localStorage.getItem(KEY)) return
    } catch {
      // fall through: follow the system
    }
    document.documentElement.classList.toggle("dark", query.matches)
  }
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}
