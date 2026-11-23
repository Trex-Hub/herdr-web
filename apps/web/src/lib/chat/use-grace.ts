import { useEffect, useState } from "react"

/** True once `active` has been so for `ms`, and false again as soon as it is not. */
export function useGrace(active: boolean, ms: number): boolean {
  const [over, setOver] = useState(false)
  useEffect(() => {
    if (!active) {
      setOver(false)
      return
    }
    const timer = setTimeout(() => setOver(true), ms)
    return () => clearTimeout(timer)
  }, [active, ms])
  return over
}
