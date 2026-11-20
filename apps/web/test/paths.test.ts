import { describe, expect, it } from "vitest"
import { displayFolder } from "@/lib/paths"

describe("displayFolder", () => {
  it.each([
    ["/Users/dev", "~"],
    ["/Users/dev/", "~"],
    ["/home/zosma", "~"],
    ["/root", "~"],
    ["/root/", "~"],
  ])("the home folder itself is ~: %s", (folder, shown) => expect(displayFolder(folder)).toBe(shown))

  it.each([
    ["/Users/dev/Desktop", "~/Desktop"],
    ["/Users/dev/Desktop/herdr-web", "~/Desktop/herdr-web"],
    ["/root/work", "~/work"],
  ])("a short path under home keeps all of it: %s", (folder, shown) => expect(displayFolder(folder)).toBe(shown))

  it.each([
    ["/home/zosma/x/y/z", "~/…/y/z"],
    ["/Users/dev/Desktop/devendras-work/herdr-web", "~/…/devendras-work/herdr-web"],
    ["/root/a/b/c", "~/…/b/c"],
  ])("a long path under home keeps ~ and its last two parts: %s", (folder, shown) => expect(displayFolder(folder)).toBe(shown))

  it("a path outside a home folder keeps its last two parts, and a short one stays whole", () => {
    expect(displayFolder("/srv/apps/api/service")).toBe("/…/api/service")
    expect(displayFolder("/srv/app")).toBe("/srv/app")
    expect(displayFolder("/srv")).toBe("/srv")
    expect(displayFolder("/tmp/hw-sidebar/x")).toBe("/…/hw-sidebar/x")
    expect(displayFolder("/")).toBe("/")
  })

  it("only /Users/<name>, /home/<name> and /root count as a home folder", () => {
    expect(displayFolder("/Users")).toBe("/Users")
    expect(displayFolder("/home")).toBe("/home")
    expect(displayFolder("/Users/dev2/a")).toBe("~/a") // another person's folder is still a home folder
    expect(displayFolder("/rootbeer/a/b/c")).toBe("/…/b/c")
    expect(displayFolder("/srv/Users/dev/a")).toBe("/…/dev/a") // not at the start: not a home folder
  })

  it("the last folder's name is never cut", () => {
    const long = "a-very-long-folder-name-that-goes-on-and-on-and-on-and-on"
    expect(displayFolder(`/Users/dev/x/y/${long}`)).toBe(`~/…/y/${long}`)
    expect(displayFolder(`/home/zosma/${long}`)).toBe(`~/${long}`)
  })

  it("a Windows or relative path is left as it is", () => {
    expect(displayFolder("C:\\Users\\dev\\work\\app")).toBe("C:\\Users\\dev\\work\\app")
    expect(displayFolder("C:/Users/dev/work/app")).toBe("C:/Users/dev/work/app")
    expect(displayFolder("work/app/x/y")).toBe("work/app/x/y")
    expect(displayFolder("")).toBe("")
  })
})
