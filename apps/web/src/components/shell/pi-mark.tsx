import type { SVGProps } from "react"

/**
 * pi's mark, in one colour. Its shape is taken from pi's own logo (https://pi.dev/logo-auto.svg, pi is MIT licensed:
 * https://github.com/earendil-works/pi); the three coloured blocks of that logo are drawn here as one `currentColor`
 * shape on its 469 × 469 box, so it sits among the other icons.
 */
export function PiMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="165.29 165.29 469.43 469.43" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
      <path d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z" />
      <path d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  )
}
