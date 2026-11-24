// Stands in for `next/font/google`, which only works under Next's compiler.
type Options = { variable?: string }
const font = (family: string) => (o: Options) => ({ className: "", variable: o.variable ?? "", style: { fontFamily: `'${family}'` } })

export const Figtree = font("Figtree")
export const Space_Grotesk = font("Space Grotesk")
export const JetBrains_Mono = font("JetBrains Mono")
