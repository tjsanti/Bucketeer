// Reordering the bucket table: pointer drag from a row's grip, Alt+Up/Down on a row's button, and the
// phone Reorder state's up and down buttons. This module only finds the target; the page saves the move.
//
// The table it works on (.btable) has [role="row"] rows, a group's rows following its group row; groups may
// sit apart, with space between them. It marks its rows with data attributes:
//   group row         .bgroup[data-group-id]      its grip [data-grip]; its button .more-btn[data-group-id]
//   bucket row        .brow[data-bucket-id]       its grip [data-grip]; its button .name-btn[data-bucket-id]
//   empty group row   .bempty[data-group-id]      a drop target
//   move buttons      .mv[data-kind][data-id][data-dir="-1"|"1"]

export type MoveKind = "bucket" | "group";

export interface MoveKey {
  kind: MoveKind;
  id: string;
}

/** Where an item goes. The index is 0-based in the target list with the item taken out (as the API expects). */
export interface MoveTarget {
  groupId?: string;
  index: number;
}

export interface Layout {
  groups: readonly { id: string; bucketIds: readonly string[] }[];
}

export function locate(layout: Layout, key: MoveKey): { groupId?: string; index: number } | null {
  if (key.kind === "group") {
    const index = layout.groups.findIndex((group) => group.id === key.id);
    return index < 0 ? null : { index };
  }
  for (const group of layout.groups) {
    const index = group.bucketIds.indexOf(key.id);
    if (index >= 0) return { groupId: group.id, index };
  }
  return null;
}

/** One place up or down. A bucket crosses into the neighbouring group at its group's edges. */
export function stepTarget(layout: Layout, key: MoveKey, dir: -1 | 1): MoveTarget | null {
  const { groups } = layout;
  if (key.kind === "group") {
    const next = groups.findIndex((group) => group.id === key.id) + dir;
    return next < 0 || next >= groups.length ? null : { index: next };
  }
  const groupIndex = groups.findIndex((group) => group.bucketIds.includes(key.id));
  const group = groups[groupIndex];
  if (!group) return null;
  const index = group.bucketIds.indexOf(key.id);
  if (dir < 0) {
    if (index > 0) return { groupId: group.id, index: index - 1 };
    const previous = groups[groupIndex - 1];
    return previous ? { groupId: previous.id, index: previous.bucketIds.length } : null;
  }
  if (index < group.bucketIds.length - 1) return { groupId: group.id, index: index + 1 };
  const next = groups[groupIndex + 1];
  return next ? { groupId: next.id, index: 0 } : null;
}

export interface ReorderConfig {
  layout(): Layout;
  /** Saves a move. Only called when the target differs from where the item is. Direction is up (-1) or down (1) within one list. */
  move(key: MoveKey, target: MoveTarget, direction: -1 | 1): void;
  /** The item cannot go further that way. */
  atEdge(key: MoveKey, dir: -1 | 1): void;
  /** Called when a drag starts, so the page can close its menus. */
  dragStarted?(): void;
}

interface Slot {
  y: number;
  lineY?: number;
  target: MoveTarget;
  group?: HTMLElement;
  empty?: HTMLElement;
}

interface Drag {
  table: HTMLElement;
  key: MoveKey;
  row: HTMLElement;
  block: HTMLElement[];
  ghost: HTMLElement;
  line: HTMLElement;
  offset: number;
  x: number;
  y: number;
  target: MoveTarget | null;
  raf: number;
}

const sameTarget = (a: MoveTarget, b: { groupId?: string; index: number }) => a.groupId === b.groupId && a.index === b.index;
const shows = (row: Element) => row.getClientRects().length > 0;

/** A group row and the rows that follow it up to the next group row: its buckets, archived rows, or No buckets. */
function blockOf(groupRow: HTMLElement): HTMLElement[] {
  const block = [groupRow];
  for (let next = groupRow.nextElementSibling; next instanceof HTMLElement && !next.classList.contains("bgroup"); next = next.nextElementSibling) block.push(next);
  return block;
}

/** Wires drag, keyboard and move buttons into a container whose table is re-rendered freely. */
export function attachReorder(container: HTMLElement, config: ReorderConfig): { cancel(): void } {
  let drag: Drag | null = null;
  let stopListening: (() => void) | null = null;

  const keyOf = (row: HTMLElement): MoveKey => row.dataset.bucketId
    ? { kind: "bucket", id: row.dataset.bucketId }
    : { kind: "group", id: row.dataset.groupId! };

  function step(key: MoveKey, dir: -1 | 1): void {
    const target = stepTarget(config.layout(), key, dir);
    if (target) config.move(key, target, dir);
    else config.atEdge(key, dir);
  }

  container.addEventListener("keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const button = (event.target as Element).closest<HTMLElement>(".name-btn[data-bucket-id], .more-btn[data-group-id], .mv[data-id]");
    if (!button) return;
    event.preventDefault();
    const key: MoveKey = button.classList.contains("mv")
      ? { kind: button.dataset.kind as MoveKind, id: button.dataset.id! }
      : button.dataset.bucketId ? { kind: "bucket", id: button.dataset.bucketId } : { kind: "group", id: button.dataset.groupId! };
    step(key, event.key === "ArrowUp" ? -1 : 1);
  });

  container.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLElement>(".mv[data-id]");
    if (!button || button.getAttribute("aria-disabled") === "true") return;
    step({ kind: button.dataset.kind as MoveKind, id: button.dataset.id! }, Number(button.dataset.dir) as -1 | 1);
  });

  // Every place the dragged row could land, with the y of the line for it.
  function slots(current: Drag): Slot[] {
    const { table } = current;
    const out: Slot[] = [];
    if (current.key.kind === "group") {
      // A group lands between two groups' cards, so its line sits in the middle of the gap above a group row.
      const shown = [...table.querySelectorAll<HTMLElement>('[role="row"]')].filter(shows);
      const position = new Map(shown.map((row, index) => [row, index]));
      const lineAbove = (row: HTMLElement) => {
        const top = row.getBoundingClientRect().top;
        const above = shown[(position.get(row) ?? 0) - 1];
        return above ? (above.getBoundingClientRect().bottom + top) / 2 : top;
      };
      const groups = [...table.querySelectorAll<HTMLElement>(".bgroup")].filter((row) => row !== current.row);
      groups.forEach((row, index) => out.push({ y: row.getBoundingClientRect().top, lineY: lineAbove(row), target: { index } }));
      // The end is the last other group's last row on screen, not rows after every group or ones Reorder hides.
      const lastGroup = groups.at(-1);
      const last = lastGroup && blockOf(lastGroup).filter(shows).at(-1);
      out.push({ y: last ? last.getBoundingClientRect().bottom : current.row.getBoundingClientRect().top, target: { index: groups.length } });
      return out;
    }
    for (const group of config.layout().groups) {
      const groupRow = table.querySelector<HTMLElement>(`.bgroup[data-group-id="${CSS.escape(group.id)}"]`);
      if (!groupRow) continue;
      const rows = group.bucketIds.filter((id) => id !== current.key.id)
        .map((id) => table.querySelector<HTMLElement>(`.brow[data-bucket-id="${CSS.escape(id)}"]`))
        .filter((row): row is HTMLElement => row !== null);
      const groupBottom = groupRow.getBoundingClientRect().bottom;
      if (!rows.length) {
        const empty = table.querySelector<HTMLElement>(`.bempty[data-group-id="${CSS.escape(group.id)}"]`) ?? undefined;
        out.push({ y: empty ? groupBottom + empty.offsetHeight / 2 : groupBottom, lineY: groupBottom, target: { groupId: group.id, index: 0 }, group: groupRow, ...(empty ? { empty } : {}) });
        continue;
      }
      rows.forEach((row, index) => out.push({ y: row.getBoundingClientRect().top, target: { groupId: group.id, index }, group: groupRow }));
      out.push({ y: rows.at(-1)!.getBoundingClientRect().bottom, target: { groupId: group.id, index: rows.length }, group: groupRow });
    }
    return out;
  }

  function dragTo(current: Drag, y: number): void {
    current.y = y;
    current.ghost.style.top = `${y - current.offset}px`;
    let best: Slot | null = null;
    let distance = Infinity;
    for (const slot of slots(current)) {
      const d = Math.abs(slot.y - y);
      if (d < distance) { distance = d; best = slot; }
    }
    current.target = best?.target ?? null;
    for (const lit of current.table.querySelectorAll(".drop-into")) lit.classList.remove("drop-into");
    if (!best) return;
    const bounds = current.table.getBoundingClientRect();
    current.line.style.top = `${best.lineY ?? best.y}px`;
    current.line.style.left = `${bounds.left + 6}px`;
    current.line.style.width = `${bounds.width - 12}px`;
    best.empty?.classList.add("drop-into");
    const from = locate(config.layout(), current.key);
    if (current.key.kind === "bucket" && best.group && best.target.groupId !== from?.groupId) best.group.classList.add("drop-into");
  }

  function autoScroll(): void {
    if (!drag) return;
    const edge = 64;
    const height = window.innerHeight;
    const speed = drag.y < edge ? -Math.ceil((edge - drag.y) / 3) : drag.y > height - edge ? Math.ceil((drag.y - (height - edge)) / 3) : 0;
    if (speed) {
      const before = window.scrollY;
      window.scrollBy(0, speed);
      if (window.scrollY !== before) dragTo(drag, drag.y);
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function begin(row: HTMLElement, y: number): Drag | null {
    const table = row.closest<HTMLElement>(".btable");
    if (!table) return null;
    config.dragStarted?.();
    const key = keyOf(row);
    const block = key.kind === "group" ? blockOf(row) : [row];
    const tableBox = table.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    const ghost = document.createElement("div");
    ghost.className = `${table.className} drag-ghost`;
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    for (const part of block) {
      const copy = part.cloneNode(true) as HTMLElement;
      copy.classList.remove("moved");
      ghost.append(copy);
    }
    Object.assign(ghost.style, { width: `${tableBox.width}px`, left: `${tableBox.left}px`, top: `${rowBox.top}px` });
    document.body.append(ghost);
    for (const part of block) part.classList.add("drag-src");
    const line = document.createElement("div");
    line.className = "drop-line";
    line.setAttribute("aria-hidden", "true");
    document.body.append(line);
    document.body.classList.add("is-dragging");
    const current: Drag = { table, key, row, block, ghost, line, offset: y - rowBox.top, x: tableBox.left + tableBox.width / 2, y, target: null, raf: 0 };
    drag = current;
    dragTo(current, y);
    current.raf = requestAnimationFrame(autoScroll);
    return current;
  }

  function end(commit: boolean): void {
    stopListening?.();
    const current = drag;
    if (!current) return;
    drag = null;
    cancelAnimationFrame(current.raf);
    current.ghost.remove();
    current.line.remove();
    for (const part of current.block) part.classList.remove("drag-src");
    for (const lit of current.table.querySelectorAll(".drop-into")) lit.classList.remove("drop-into");
    document.body.classList.remove("is-dragging");
    if (!commit || !current.target) return;
    const bounds = current.table.getBoundingClientRect();
    if (current.x < bounds.left || current.x > bounds.right || current.y < 0 || current.y > window.innerHeight) return;
    const from = locate(config.layout(), current.key);
    if (!from || sameTarget(current.target, from)) return;
    config.move(current.key, current.target, current.target.index < from.index ? -1 : 1);
  }

  container.addEventListener("pointerdown", (event) => {
    const grip = (event.target as Element).closest<HTMLElement>("[data-grip]");
    if (!grip || drag || stopListening || !event.isPrimary || event.button !== 0) return;
    if (getComputedStyle(grip).display === "none") return;
    const row = grip.closest<HTMLElement>(".bgroup, .brow");
    if (!row) return;
    event.preventDefault();
    const { pointerId } = event;
    const startX = event.clientX;
    const startY = event.clientY;
    grip.setPointerCapture?.(pointerId);
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (!drag) {
        if (Math.abs(move.clientY - startY) < 4 && Math.abs(move.clientX - startX) < 4) return;
        if (!begin(row, startY)) { stopListening?.(); return; }
      }
      drag!.x = move.clientX;
      dragTo(drag!, move.clientY);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      if (drag) drag.x = up.clientX;
      end(up.type === "pointerup");
    };
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopPropagation();
      end(false);
    };
    const onBlur = () => end(false);
    stopListening = () => {
      stopListening = null;
      if (grip.hasPointerCapture?.(pointerId)) grip.releasePointerCapture(pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("keydown", onKey, true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("keydown", onKey, true);
  });

  return { cancel: () => end(false) };
}
