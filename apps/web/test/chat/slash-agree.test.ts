import { describe, expect, it } from "vitest"
import { PI_BUILTIN_COMMANDS } from "../../../../packages/agents/src/pi-live/wire"
import { TYPED_COMMANDS } from "@/lib/chat/format"

// The backend types pi's built-ins into the terminal and sends everything else; the web says so under the composer from its own list.
describe("the web and pi-live's list of built-in commands", () => {
  it("are the same words", () => {
    expect([...TYPED_COMMANDS].sort()).toEqual([...PI_BUILTIN_COMMANDS].sort())
  })
})
