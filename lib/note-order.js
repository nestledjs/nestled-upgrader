// The order notes are applied in. A consumer applies a release's notes one after another on the same
// working tree, so a note whose patch assumes another note's change must come after it. Two things
// decide that order, in this priority:
//
// 1. `applyAfter: [<id>, ...]` on a note: an explicit prerequisite, always honoured.
// 2. Otherwise a caller-supplied rank (sync order, when known), then id. Ids are date-prefixed, so id
//    order is the order notes were written in, which is what every release used before.
//
// A cycle can't be ordered and is reported, never broken arbitrarily.

/** `applyAfter` as a list of ids, whether the note wrote one id or a list. */
export function applyAfterIds(note) {
  const value = note?.applyAfter;
  if (value == null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((entry) => String(entry).trim()).filter(Boolean))];
}

function compareDefault(a, b) {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Order `notes` (objects with an `id`) so every note comes after the notes it declares in
 * `applyAfter`. Prerequisites outside `notes` are ignored here; callers check those themselves.
 *
 * Returns `{ ordered, cycle }`. When the prerequisites form a cycle, `ordered` is the default order
 * and `cycle` lists the ids in the cycle or waiting on it.
 */
export function orderNotes(notes, { rank = () => 0 } = {}) {
  const entries = notes.map((note) => ({ note, id: String(note.id), rank: rank(note) }));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const prerequisites = new Map(
    entries.map((entry) => [
      entry,
      applyAfterIds(entry.note)
        .filter((id) => byId.has(id) && id !== entry.id)
        .map((id) => byId.get(id)),
    ]),
  );
  const remaining = new Map(entries.map((entry) => [entry, prerequisites.get(entry).length]));
  const dependents = new Map(entries.map((entry) => [entry, []]));
  for (const [entry, before] of prerequisites)
    for (const prerequisite of before) dependents.get(prerequisite).push(entry);

  const ready = entries.filter((entry) => remaining.get(entry) === 0);
  const ordered = [];
  while (ready.length) {
    ready.sort(compareDefault);
    const next = ready.shift();
    ordered.push(next);
    for (const dependent of dependents.get(next)) {
      remaining.set(dependent, remaining.get(dependent) - 1);
      if (remaining.get(dependent) === 0) ready.push(dependent);
    }
  }
  if (ordered.length < entries.length) {
    const cycle = entries
      .filter((entry) => remaining.get(entry) > 0)
      .map((entry) => entry.id)
      .sort();
    return { ordered: [...entries].sort(compareDefault).map((entry) => entry.note), cycle };
  }
  return { ordered: ordered.map((entry) => entry.note), cycle: [] };
}
