# Gulv Master Portal – Dagsrapport & JobTread-timer

Denne opdatering fjerner den interne start/stop-timer fra medarbejdersiden.

Medarbejderen kan nu kun bruge **"Registrer dagens arbejde"** på en planlagt opgave. Indsendelse er blokeret både i browseren og på serveren, indtil følgende er med:

1. Rapportdato (låst til den planlagte dag)
2. Timer mellem 0,25 og 16
3. Arbejdsnote på mindst 10 tegn
4. Mindst ét foto (maks. fem)

Serveren opretter først en dagsrapport i den fælles database og uploader fotoet til Cloudinary. Den afleverer derefter rapporten til en sikker **JobTread-connector**. Kun når connectoren svarer med `{ "ok": true }`, får rapporten status **Sendt til JT**. Hvis connectoren fejler, bliver rapporten gemt som **Fejlet** i admin, hvor den kan gensendes uden at medarbejderen skal indtaste alt igen.

## Filer, du skal erstatte på GitHub

Erstat disse filer fra denne mappe:

- `server.js`
- `employee.html`
- `admin.html`
- `package.json`
- `.env.example`
- `README_DAGSREPORT.md`

Commit og push derefter. Render installerer de to nye pakker automatisk ved næste deploy.

## Nye Render Environment Variables

Tilføj disse under **Render → din service → Environment**. Gem dem aldrig i GitHub.

```text
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
JT_REPORT_WEBHOOK_URL=https://hook.eu2.make.com/...
JT_REPORT_WEBHOOK_SECRET=lang-tilfaeldig-hemmelig-tekst
```

De eksisterende værdier skal blive stående:

```text
JWT_SECRET=...
JT_ORG_ID=22PZCGuGrJnQ
JT_GRANT_KEY=...
```

### Cloudinary

Opret et Cloudinary-product environment og lav en API key. Fotoene bliver lagret der, så de ikke forsvinder ved en Render-redeploy. Render-filsystemet må ikke bruges som permanent billedlager.

## Make: JobTread report connector

Opret et nyt separat Make-scenario. Medarbejderen bruger aldrig Make eller JobTread direkte; dette er kun server-til-server.

1. **Webhooks → Custom webhook**
   - Kopiér webhook-URL'en til `JT_REPORT_WEBHOOK_URL` på Render.
   - Kør **Run once** og indsend en test-dagsrapport fra medarbejderportalen, så Make læser felterne.

2. **Sikkerhed**
   - Kontrollér request headeren `x-gulvmaster-report-secret` mod din `JT_REPORT_WEBHOOK_SECRET`.
   - Stop scenariet ved forkert secret.

3. **JobTread: opret Time Entry**
   Brug JobTreads API-dokumentation i jeres konto til at oprette en Time Entry med mindst:

   ```text
   Job:       task.job_id
   Bruger:    worker.jobtread_user_id (helst) eller worker.jobtread_name
   Dato:      report.date
   Timer:     report.hours
   Note:      report.notes + "\n\nTask: " + task.name
   ```

4. **JobTread: gem dokumentationen**
   Upload alle `photos[].url` på det samme Job som dokumenter/fotos eller på en Daily Log, alt efter den handling jeres JobTread API stiller til rådighed.

5. **Webhook Response** – skal være sidste modul og må kun køre når både Time Entry og foto/dokumentation er oprettet:

   ```json
   {
     "ok": true,
     "time_entry_id": "JobTread-ID-her",
     "daily_log_id": "valgfrit-JobTread-ID"
   }
   ```

Hvis et af JobTread-trinnene fejler, skal Webhook Response i stedet returnere status 400/500 eller:

```json
{ "ok": false, "error": "Forklaring fra JobTread" }
```

Portalen markerer **aldrig** rapporten som sendt, bare fordi Make-webhookpen er nået. Den kræver svaret `ok: true`.

## JobTread bruger-ID

Under **Hold & vendors → Rediger medarbejder** er der nu et valgfrit felt:

```text
JobTread bruger-/medlems-ID
```

Udfyld det på hver intern medarbejder, når I har fundet ID'et i JobTread API-dokumentationen. Det er mere sikkert end kun at matche på navn.

## Det, der er ændret i appen

- Den gamle intern timer og "JobTread timer"-knap er fjernet fra medarbejdersiden.
- Ny mobilvenlig dagsrapport-formular med obligatoriske billeder og noter.
- Ny `daily_reports` og `daily_report_photos` database-struktur oprettes automatisk; gamle bookinger slettes ikke.
- Admin-fanen **Dagsrapporter & timer** viser note, billeder, status, JobTread-synk og en **Gensend**-knap ved fejl.
- JobTread sync er fortsat kun en read-only task-pool; den ændrer aldrig din plan.
