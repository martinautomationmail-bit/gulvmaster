# v2.0.0 — Render Postgres

- Erstattet lokal `better-sqlite3` drift med Render Postgres til appens rigtige data.
- Tilføjet sikker engangsimport fra SQLite via `/migrate`.
- Filer og data holdes adskilt: GitHub-opdateringer ændrer kun kode.
- Fjernet usikker `express.static(__dirname)`-adfærd. Databaser, backupfiler og serverkode udstilles ikke som offentlige filer.
- Bevarer de eksisterende API-endpoints til admin- og medarbejder-siderne.
- Håndhæver regel: JobTread-synk må kun upserte `jt_tasks` og kan aldrig ændre `planning_bookings`.
- Bevarer manuel planlægning som selvstændige bookingrækker, så samme JobTread-task kan planlægges på flere personer og datoer.
