import { notFound } from "next/navigation"
import { DevShell } from "./dev-shell"

/** The sidebar on fixtures, with no backend. Development only: a production build answers 404. */
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound()
  return <DevShell />
}
