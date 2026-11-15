import { notFound } from "next/navigation"
import { DevChat } from "./dev-chat"

/** The chat components on fixtures. Development only: a production build answers 404. */
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound()
  return <DevChat />
}
