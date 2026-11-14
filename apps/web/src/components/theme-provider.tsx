"use client"

import { ThemeProvider as NextThemesProvider } from "next-themes"
import type * as React from "react"

/** Dark and light follow the system until the toggle is used; the choice is kept in localStorage. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  )
}
