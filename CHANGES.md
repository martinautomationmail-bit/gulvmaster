# v1.2 — Manuelt planlægningsboard

- JobTread Tasks importeres kun til opgavepoolen; de opretter aldrig bookinger.
- Ny `planning_bookings`-tabel bruges i stedet for den gamle `assignments`-tabel. Det betyder, at gamle automatiske tildelinger ikke kommer med ind i den nye plan.
- Opgaver kan bookes på flere personer og datoer. Den samme Task bliver altid liggende i poolen.
- Drag & drop bruger nu én event-delegeret handler, så et drop kun kan lave én booking.
- Daglig plan og Kapacitet har separate funktioner.
- Kapacitetsboard har 52 ugers vandret scroll, måneds-hop, faggruppefiltre og vendor-grupper med undergrupper.
- Vendor-undergrupper kan oprettes uden email/login.
