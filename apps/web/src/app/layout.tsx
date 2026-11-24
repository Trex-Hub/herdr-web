import type { Metadata, Viewport } from "next"
import "./globals.css"
import { ThemeFollower } from "@/components/theme-follower"
import { figtree, jetbrainsMono, spaceGrotesk } from "@/lib/fonts"
import { themeScript } from "@/lib/theme"

export const metadata: Metadata = {
  title: "herdr web",
  description: "A web client for herdr-core",
}

export const viewport: Viewport = { width: "device-width", initialScale: 1 }

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${figtree.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeFollower />
        {children}
      </body>
    </html>
  )
}
