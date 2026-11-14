"use client"

import { useEffect } from "react"
import { followSystem } from "@/lib/theme"

/** Keeps the page in step with the system theme until the toggle has been used. */
export function ThemeFollower() {
  useEffect(() => followSystem(), [])
  return null
}
