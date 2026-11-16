// Tiny DOM helpers shared by the UI modules. Text always goes in as text nodes, never as HTML.
export type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

const svgNs = "http://www.w3.org/2000/svg";

/** An icon from the symbol sprite in index.html. */
export function icon(name: string, size?: "sm"): SVGSVGElement {
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("class", size ? `icon ${size}` : "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svgNs, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Try again.";
}

/** A neutral message with an alert icon. Red is reserved for overspent buckets. */
export function setNote(target: HTMLElement, message: string | null): void {
  target.replaceChildren(...(message ? [icon("alert", "sm"), el("span", {}, message)] : []));
}
