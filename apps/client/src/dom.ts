/** Keep controls, focus and scroll positions alive across server snapshots. */
export function updateMarkup(root: Element, html: string): void {
  const template = document.createElement("template");
  template.innerHTML = html;
  const key = (node: Node): string => node instanceof Element
    ? node.id || ["data-card-id", "data-action", "data-drop-slot", "data-slot", "data-log-tab", "data-log-nav"]
      .map((attribute) => node.hasAttribute(attribute) ? `${attribute}:${node.getAttribute(attribute)}` : "").find(Boolean) || ""
    : "";
  const sync = (parent: Node, incoming: Node): void => {
    const children = [...incoming.childNodes];
    children.forEach((next, index) => {
      let current = parent.childNodes[index];
      const nextKey = key(next);
      if (nextKey && key(current ?? next) !== nextKey) {
        const found = [...parent.childNodes].find((node) => key(node) === nextKey);
        if (found) { parent.insertBefore(found, current ?? null); current = found; }
      }
      if (!current || current.nodeName !== next.nodeName || key(current) !== nextKey) {
        if (current) parent.replaceChild(next.cloneNode(true), current);
        else parent.appendChild(next.cloneNode(true));
        return;
      }
      if (current instanceof Element && next instanceof Element) {
        for (const attribute of [...current.attributes]) {
          if (!next.hasAttribute(attribute.name) && !(current instanceof HTMLDialogElement && attribute.name === "open")) {
            current.removeAttribute(attribute.name);
          }
        }
        for (const attribute of [...next.attributes]) {
          if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
        }
        sync(current, next);
      } else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    });
    while (parent.childNodes.length > children.length) parent.lastChild!.remove();
  };
  sync(root, template.content);
}
