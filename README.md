# Gulv Master – medarbejderportal og kapacitetsboard

Denne version bygger videre på Claude-koden og samler det i ét admin-system:

- **Daglig planlægning:** Træk Task fra opgavepoolen til en medarbejder og en specifik dag.
- **Kapacitetsboard:** Træk samme Task til en medarbejder/et vendor-hold og en bestemt uge. Her kan du se bookede dage mod kapacitet.
- **Medarbejdere øverst:** Interne medarbejdere vises altid før vendors.
- **Vendor-grupper:** Vælg `Vendor / underleverandør` og en `Vendor-gruppe` under Hold & vendors. Eksempel:
  - AJB Gruppen APS → Gulvlægning
  - AJB Gruppen APS → Slibning
  - Novo-Gulvservice → Slibning
- **Manuelle opgaver:** Opret en manuel opgave i opgavepoolen og træk den ind på boardet.
- **Ingen auto-tildeling:** JobTread synk importerer kun/fornyer Task-data. Den opretter ikke tildelinger og ændrer ikke din manuelle plan.
- **Drag & drop:** Der bruges både `dataTransfer` og et fallback i browseren, så det virker stabilt på Chrome, Edge og Firefox.
- **Medarbejderportal:** Medarbejdere ser kun deres egne bookinger. Der er både intern start/stop-timer og en knap, der åbner JobTread Time Tracking.

## Det vigtigste der er rettet

Den oprindelige `server.js` kørte `autoAssign()` ved opstart og igen efter JobTread-synk. Det er fjernet.

Den gamle drag & drop manglede `event.dataTransfer.setData(...)`. Flere browsere kræver dette for, at en drag-operation kan gennemføres. Den nye admin bruger både `application/x-gulvmaster` og `text/plain` som fallback.

`INSERT OR REPLACE` på assignments er erstattet med sikker opret/opdater-logik, så en eksisterende booking ikke bliver slettet og oprettet på ny med et nyt id.

## Kør lokalt

1. Åbn terminal i denne mappe.
2. Kør:

```bash
npm install
cp .env.example .env
npm start
```

3. Åbn:

```text
http://localhost:3000
```

## Vigtige environment variables

Sæt disse før produktion:

```text
JWT_SECRET=<lang tilfældig hemmelig nøgle>
JT_ORG_ID=22PZCGuGrJnQ
JT_GRANT_KEY=<din JobTread Grant Key>
```

Gem aldrig `JT_GRANT_KEY` i GitHub eller i HTML-filer. Brug environment variables i den hosting-platform, du vælger.

## Hosting

Dette er en Node.js + SQLite-app og kan **ikke** køre via Netlify Drop som en almindelig HTML-fil.

Brug fx Render, Railway eller en VPS. Vigtigt: SQLite-filen skal ligge på en persistent disk/volume. Uden persistent disk mister du brugere og planlægning ved redeploy.

## Første login

Koden har de eksisterende testbrugere fra den oprindelige server. Skift adgangskoder inden rigtige medarbejdere får adgang.

## Sådan bruger du planlægningen

1. Tryk **Synk JT**. Det opdaterer kun opgavepoolen.
2. Find opgaven i venstre side.
3. Træk den:
   - til **Daglig plan** for specifik dato, eller
   - til **Kapacitet** for den uge, den skal ligge i.
4. Klik på en booking for at ændre antal dage, startdato, mødetid eller note.
5. Klik `×` på en booking for at fjerne kun den interne booking. Det sletter ikke noget i JobTread.

## Bemærkning om JobTread-timer

Knapen **JobTread timer** sender medarbejderen til `https://app.jobtread.com/time`.
Den interne start/stop-funktion gemmer stadig et internt tidslog i denne app.

At sende timer automatisk ind i JobTread kræver en bekræftet JobTread API-mutation og de nødvendige API-rettigheder. Det er ikke blevet “faket” i denne version.
