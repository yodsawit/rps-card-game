export function cardCountDisplay(count: number, mode: "stack" | "individual"): string {
  const iconCount = mode === "stack" ? Math.min(count, 1) : count;
  return `<span class="card-count-display" aria-label="${count} cards left"><span class="card-count-icons" aria-hidden="true">${Array.from(
    { length: iconCount },
    () => "<i></i>"
  ).join("")}</span>${mode === "stack" ? `<b>&times;${count}</b>` : count === 0 ? "<b>0</b>" : ""}</span>`;
}
