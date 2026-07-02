# Gulv Master — sikker Postgres-version

Denne version flytter portalen væk fra en lokal SQLite-fil og over på Render Postgres.

## Det der er bygget ind

- `GitHub` = kun kode.
- `Render Postgres` = medarbejdere, logins, vendors, faggrupper, JobTread task-pool, interne bookinger, noter og kapacitetsdata.
- `JobTread-sync` opdaterer **kun** tabellen `jt_tasks`.
- Synken kan ikke oprette, ændre eller slette `planning_bookings`.
- `/migrate` er en beskyttet engangs-side, hvor du uploader din gamle `gulvmaster.db` direkte til din egen Render-service. Filen slettes fra serverens midlertidige mappe lige efter importen.

## VIGTIGT: Hvad den uploadede database indeholder

Den database, der blev eksporteret 2. juli 2026, indeholder:

- 11 brugere / medarbejdere / vendors
- 40 JobTread Tasks
- 2 synk-loglinjer
- 0 `planning_bookings`
- 0 `assignments`
- 0 `time_logs`

Det betyder, at der ikke findes konkrete interne bookinger, noter eller timer i netop den databasefil, som kan flyttes. Alt den indeholder flyttes. Nye bookinger bliver fremover gemt permanent i Postgres.

## Deployment — kun browser, ingen Shell

### 1. Erstat projektfiler i GitHub

Upload/erstat alle filer i denne mappe i roden af dit GitHub-projekt:

- `server.js`
- `package.json`
- `index.html`
- `admin.html`
- `employee.html`
- `migrate.html`

Skriv fx commit-besked:

`Flyt Gulv Master portal til Render Postgres`

### 2. Tilføj to Render Environment Variables

På **Gulv Master webservicen** i Render:

1. Gå til **Environment** → **Edit** → **Add Environment Variable**.
2. Tilføj `DATABASE_URL`.
   - Værdien skal være den **Internal Database URL** fra din Render Postgres database.
   - Brug den nye credential `gulvmaster_portal_migration`.
   - Gør dette i Render UI. Brug ikke Web Shell.
3. Tilføj `MIGRATION_SECRET`.
   - Vælg en lang hemmelig kode, fx din egen kombination af ord og tal.
   - Den bruges kun én gang på `/migrate`.
4. Vælg **Save only** mens GitHub-filerne ikke er skiftet endnu.

### 3. Lad Render deploye GitHub-opdateringen

Efter GitHub-commit deployer Render automatisk. Vent til deploy står som **Live**.

### 4. Importér din gamle database én gang

1. Åbn `https://gulvmaster.onrender.com/migrate`
2. Indtast præcis samme `MIGRATION_SECRET`.
3. Vælg den downloadede fil `gulvmaster.db`.
4. Tryk **Flyt data til Postgres**.
5. Vent på grøn success-besked.
6. Gå til login og test admin/medarbejdersiden.

### 5. Ryd op efter test

Når login, medarbejdere og task-pool er kontrolleret:

- Fjern `MIGRATION_SECRET` fra Render Environment.
- Behold `DATABASE_URL` permanent.
- Gem den gamle `gulvmaster.db` lokalt som ekstra backup, men upload den ikke til GitHub.

## Stop-regel

Deploy aldrig denne version, før `DATABASE_URL` er sat i Render. Serveren stopper bevidst ved opstart uden den, så den aldrig falder tilbage til en ny tom lokal database.
