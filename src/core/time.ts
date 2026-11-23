// "Today" and "this month" are calendar dates in one time zone: the server's by default (ADR-0007).

export interface Calendar {
  /** "YYYY-MM-DD" of the instant in this zone. */
  dateOf(instant: Date): string;
  /** "YYYY-MM" of the instant in this zone. */
  monthOf(instant: Date): string;
}

/** The process's zone, which honours TZ. An empty TZ, which Intl reports as Etc/Unknown, means UTC. */
export function defaultTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === "Etc/Unknown" ? "UTC" : zone;
}

/** Throws RangeError for a zone Intl doesn't know. */
export function calendarIn(timeZone: string): Calendar {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateOf = (instant: Date) => {
    const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
    return `${parts.year!.padStart(4, "0")}-${parts.month}-${parts.day}`;
  };
  return { dateOf, monthOf: (instant) => dateOf(instant).slice(0, 7) };
}
