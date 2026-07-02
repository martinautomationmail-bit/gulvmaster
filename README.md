# Gulv Master Portal v1.2

## Det vigtige i denne version

JobTread er kun en **read-only Task-pool**. Din interne plan lever i `planning_bookings` og synkronisering ændrer aldrig bookinger.

Når serveren starter, oprettes `planning_bookings` automatisk som en ny, tom plan. Den gamle `assignments`-tabel bliver ikke slettet, men den bruges ikke længere. Det fjerner gamle automatiske tildelinger uden at slette dem fysisk.

## Deploy

1. Erstat projektfilerne med denne mappe.
2. Commit/push til GitHub og deploy din Node/Render-service igen.
3. Sæt mindst `JWT_SECRET`, `JT_GRANT_KEY` og `JT_ORG_ID` som Environment Variables.
4. Log ind som admin og tryk **Synk JT**. Tasks vises i poolen, men ingen bliver booket automatisk.

## Planlægning

- Drag fra opgavepool til **Daglig plan**: opretter én manuel booking på den dato og det hold, du valgte. Standard er 1 dag. Klik på bookingen for at ændre dage, tid og note.
- Drag fra opgavepool til **Kapacitet**: opretter én manuel booking på mandag i den valgte uge. Flyt den derefter til præcis dag under Daglig plan.
- En Task bliver i poolen efter den er booket, så du kan planlægge den flere steder.
- Dragging af en eksisterende booking flytter kun netop den booking.

## Vendor-undergrupper

Under **Hold & vendors**: Tryk `+ Vendor-gruppe`, indtast firmanavn, og opret derefter den første undergruppe. Vendor-undergrupper behøver ikke login; de bruges kun som kapacitetsrækker.

## Fagfiltre

Sæt fx `Gulvslibning`, `Maler`, `Tømrer` eller `VVS / El` under et hold. Der kommer automatisk et filter i både Daglig plan og Kapacitet.
