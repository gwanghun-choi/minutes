# The application and PostgreSQL meet on an external Docker network

**Date:** 2026-08-23
**Status:** accepted

## Context

PostgreSQL is deployed as its own compose project (`minutes-postgres`), separate
from the application (`minutes`). On the server both containers were on a Docker
network called `minutes-net` and the running application resolved
`DATABASE_HOST=minutes-postgres` correctly, so the deployment looked settled.

`compose.yaml` declared no networks at all. Compose therefore created an
implicit per-project default, `minutes_default`, and only the long-running
container had been attached to `minutes-net` — by hand, at some earlier point,
outside this repository.

The gap showed up the first time a *new* container was created from the file:

```
$ docker compose run --rm minutes python -m scripts.migrate
Network minutes_default  Created
psycopg.OperationalError: ... Temporary failure in name resolution
```

The same image with `docker run --network minutes-net` resolved
`minutes-postgres` to `172.18.0.2` and reached port 5432. So neither the
database, the image, nor the migration was at fault: the repository described a
different deployment from the one that was running.

## Decision

`compose.yaml` overrides the project's default network:

```yaml
networks:
  default:
    external: true
    name: minutes-net
```

**`default`, not a second named network.** A service-level `networks:` entry
would have to be repeated on every service and, more importantly, is easy to get
right for `up` and still forget for `docker compose run` — the one-off migration
container is exactly the case that broke. Replacing the default means every
container the file can produce is on `minutes-net`, with nothing to remember.

**`external: true`.** PostgreSQL's lifetime does not belong to this file. The
network outlives any `down` here, and Compose must never create a fresh empty
one that happens to carry the right name while the database sits on the old one.
The cost is a prerequisite: the network must exist before the first `up`, which
is one idempotent line in the deployment procedure and is documented in the
README, the architecture document, and `AGENTS.md`.

Compose refusing to start when the network is missing is the desired behaviour.
The alternative — inventing an isolated network — is what produced a name
resolution error that read as a database outage.

`.env.example` was corrected at the same time. It still described the retired
company instance (`DATABASE_NAME=didim_api`, empty host), which is not a
configuration this deployment can start from.

## Rejected

- **`compose.override.yaml`, or a server-only file.** It would work and would
  reproduce the original defect: the repository would again describe something
  other than what runs, and a fresh clone would again fail on the first
  migration.
- **`network_mode: host`.** Removes the port mapping and the isolation to solve
  a name resolution problem, and does not work the same way outside Linux.
- **An IP address in `DATABASE_HOST`.** Docker reassigns them; a container name
  on a shared network is the stable address.
- **Adding a PostgreSQL service to this file.** The database is shared and
  externally operated. Bringing it under `docker compose up` here would put a
  shared datastore behind this project's lifecycle commands.

## Consequences

- A new host needs one step before the first deploy:
  `docker network inspect minutes-net >/dev/null 2>&1 || docker network create minutes-net`.
- `docker compose up`, `docker compose run`, and the migration one-off all sit on
  the same network, so the migration procedure in the README works from a clean
  clone with no manual `docker network connect`.
- `minutes_default` should never be created again on a correct deployment; if it
  appears, the file being used is not this one.
- Nothing about the schema, the data, the image, or the application changes. This
  is a description of the deployment catching up with the deployment.
