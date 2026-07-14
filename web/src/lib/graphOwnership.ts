/** A retained layout is interactive only for the design that produced it. */
export function isDisplayedDesignCurrent(
  currentDesignId: string | null | undefined,
  displayedDesignId: string | null | undefined,
): boolean {
  return currentDesignId != null && displayedDesignId === currentDesignId
}

/** Response-owned overlays apply only after that exact request is laid out. */
export function isDisplayedRequestCurrent(
  currentRequestKey: string | null | undefined,
  fetchedRequestKey: string | null | undefined,
  displayedRequestKey: string | null | undefined,
): boolean {
  return (
    currentRequestKey != null &&
    fetchedRequestKey === currentRequestKey &&
    displayedRequestKey === currentRequestKey
  )
}
