# Ændringer i v1.1

## Drag & drop
- Tilføjet `dataTransfer.setData()` i begge drag-kilder.
- Bruger `application/x-gulvmaster` og `text/plain` fallback.
- Drop-zoner bruger `dragover`, `dragenter`, `dragleave` og `drop`.
- Drag fra opgavepool planlægger direkte uden ekstra modal.
- Drag af eksisterende booking flytter den og bevarer dage, note og mødetid.
- Klik efter drag undertrykkes kort, så et drop ikke bagefter åbner en modal.

## Planlægning
- `autoAssign()` er fjernet fra serverstart og JobTread-synk.
- Synk opdaterer kun task-poolen.
- `INSERT OR REPLACE` er fjernet fra booking-oprettelse.
- Serveren validerer bruger, task, dato og antal dage før en booking gemmes.
- Slutdato beregnes som arbejdsdage ud fra antal planlagte dage.

## Kapacitet
- Nyt kapacitetsboard i samme admin.
- Interne medarbejdere vises før vendors.
- Vendor-grupper vises med gruppelinjer.
- Kapacitet pr. uge kan ændres pr. medarbejder/vendor.
- Dage fordeles over arbejdsdage ved visning, så en 3-dages booking ikke tæller som 3 hele dage hver dag.

## Opgavepool
- Filtre: alle, ikke planlagt, planlagt og manuelle.
- Filtre for fag.
- Manuelle opgaver kan oprettes og trækkes på boardet.

## Hold & vendors
- Brugere har nu type, vendor-gruppe, fagområde og ugentlig kapacitet.
- Vendor-undergrupper oprettes som separate vendor-rækker med samme vendor-gruppenavn.
