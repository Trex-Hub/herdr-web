/** A home folder: `/Users/<name>`, `/home/<name>` or `/root`, at the start of a path. */
const HOME = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/

/**
 * A folder as the sidebar shows it: the home folder is `~`, and what is still long keeps its last two parts
 * (`~/…/devendras-work/herdr-web`, `…/src/lib`). The last folder's name is never cut. A Windows path is left as it is.
 */
export function displayFolder(folder: string): string {
  const home = HOME.exec(folder)
  const [root, rest] = home ? ["~", folder.slice(home[0].length)] : ["", folder]
  const parts = rest.split("/").filter(Boolean)
  if (parts.length === 0) return root || folder
  if (!home && !folder.startsWith("/")) return folder // `C:\Users\dev\x`, a relative path: not ours to shorten
  if (parts.length <= 2) return `${root}/${parts.join("/")}`
  return `${root}/…/${parts.slice(-2).join("/")}`
}
