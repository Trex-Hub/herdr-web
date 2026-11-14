import { describe, expect, it } from "vitest"
import { describeEnd } from "../src/lib/terminal/describe"

describe("how a terminal ended", () => {
  it("says the exit code, the signal, or core's reason in words", () => {
    expect(describeEnd({ reason: "exited", exitCode: 0, signal: null })).toBe("Ended: exited with code 0")
    expect(describeEnd({ reason: "exited", exitCode: 3, signal: null })).toBe("Ended: exited with code 3")
    expect(describeEnd({ reason: "killed", exitCode: null, signal: 9 })).toBe("Ended: killed by signal 9")
    expect(describeEnd({ reason: "killed", exitCode: null, signal: null })).toBe("Ended: killed")
    expect(describeEnd({ reason: "server_stop", exitCode: 1, signal: null })).toBe("Ended: core stopped (exit code 1)")
    expect(describeEnd({ reason: "something_new", exitCode: null, signal: null })).toBe("Ended: something_new")
  })
})
