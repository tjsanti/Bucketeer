# "Today" and "this month" use the server's time zone

All date rules use the time zone of the machine the app is deployed on: refusing future transactions, the current month, the default date for new transactions, and the month range. `docker-compose.yml` mounts the host's `/etc/localtime` read-only and passes `TZ` through, so `TZ=America/Los_Angeles` overrides it where the host zone isn't picked up (for example, Docker Desktop on macOS). Without this, a container defaults to UTC, and an 11pm Pacific transaction would land on tomorrow's date.

## Considered options

- **A time zone stored on each budget,** set from the browser: rejected for now. It's one household on one server.
- **The client sending its own date:** rejected. The CLI and the UI could disagree about "today".
