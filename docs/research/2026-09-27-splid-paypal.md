# Splid, PayPal und privater Schuldenausgleich

Stand: 27.09.2026. Recherche für ManaWG; keine Implementierung und keine Zahlung ausgelöst.

## Korrektur nach Präzisierung des Produktwunschs

Der Eigentümer lehnt das manuelle Hinterlegen einer Merchant-ID oder PayPal.me-Adresse ab. Gemeint ist: **Der Empfänger verbindet sein PayPal-Konto einmal per PayPal-Login; ManaWG merkt sich die Kontozuordnung. Danach wählt der Zahler zwischen manuellem Ausgleich und PayPal-Zahlung mit Weiterleitung.** Die unten stehende PayPal.me-Empfehlung ist damit verworfen und bleibt nur als Recherchehistorie erhalten.

PayPal dokumentiert diesen Verknüpfungsschritt ausdrücklich über OAuth 2.0/OpenID Connect: Ein bestehender App-Nutzer kann sein Konto mit PayPal verbinden und erhält nach Zustimmung eine Bestätigung der Verknüpfung. Das bestätigt Kontoinformationen; es ist noch keine Berechtigung für einen persönlichen Geldtransfer. [P4]

Für den produktiven Einsatz von „Log in with PayPal“ verlangt PayPal eine Prüfung der App und sämtlicher Scopes; laut aktueller Dokumentation dauert diese typischerweise einige Wochen. Sandbox-Apps benötigen diese Prüfung nicht. Konfiguriert werden Client-Zugang, freigegebene Rücksprungadresse, minimale Datenfreigaben sowie Datenschutz- und Nutzungsbedingungen-URLs. [P5]

Der generische, offiziell verlinkte Einstieg `https://www.paypal.com/myaccount/transfer/` wurde im Browser geprüft: Er führt ohne Anmeldung zum PayPal-Login und anschließend laut Hilfe zur Eingabe von Empfänger/Betrag. Er ist deshalb kein gleichwertiger Ersatz für die gewünschte vorausgefüllte Zahlung an ein verbundenes Konto. [P6]

Für **PayPal Checkout** dokumentiert PayPal inzwischen ausdrücklich, dass Empfänger auch mit einem persönlichen Konto als Verkäufer eingebunden werden können: „If you use PayPal Checkout, sellers do not need a business account. They can use their personal account to onboard.“ Dazu gehören genehmigte Partnerintegration und das offizielle Empfänger-Onboarding. Es handelt sich dabei um Checkout-Zahlungen mit möglichen geschäftlichen Zahlungsgebühren, nicht um eine Freunde-und-Familie-Überweisung. [P7]

Der Eigentümer hat inzwischen den Ablauf festgelegt: Kontoverknüpfung und Anmeldung über PayPal, Zahlungsoptionen bei PayPal, danach bestätigter Ausgleich. Es werden keine weiteren Varianten abgefragt. Die Umsetzung verwendet die offiziell unterstützte Plattformanbindung; Kontozulassung und Gebühren bleiben PayPal-abhängig. Eine Freunde-und-Familie-API wird nicht behauptet. Keine undokumentierten Linkparameter oder automatische Erfolgsbuchung allein nach einer Rückleitung einsetzen. Die bereits vorhandene Merchant-Checkout-Anbindung darf eine reine Identitätsverknüpfung nicht als Zahlungs-/Partnerfreigabe behandeln.

## Ergebnis

**Eine PayPal-Integration von Splid ist durch die geprüften öffentlichen Primärquellen nicht belegt.** Website sowie die vollständigen iOS- und Android-Beschreibungen beschreiben gemeinsame Ausgaben, Salden und vereinfachte Rückzahlungen, nennen aber weder PayPal noch eine automatische Zahlungsbestätigung. Daraus lässt sich nicht beweisen, dass keine App-Version eine solche Funktion enthält. Die installierte Splid-App wurde nicht getestet. Eine konkrete Splid-PayPal-Schnittstelle lässt sich deshalb nicht seriös zum Nachbauen benennen. [S1–S3]

**Empfehlung für ManaWG:** Für private WG-Rückzahlungen einen optionalen PayPal.me-Link mit Betrag anbieten und die tatsächliche Zahlung anschließend ausdrücklich manuell eintragen lassen. Das ist eine eigene, durch PayPal dokumentierte Lösung; kein nachgewiesener Nachbau von Splids interner Technik. [P1]

## Was Splid nachweislich macht

| Beobachtung | Beleg | Bedeutung für ManaWG |
| --- | --- | --- |
| Zeigt, wer wem wie viel schuldet | Website: „Splid listet alle eure Ausgaben auf und zeigt euch, wer wem wie viel schuldet.“ [S1] | Saldenberechnung ist von der Geldüberweisung zu unterscheiden. |
| Vereinfacht Rückzahlungen | iOS: „Minimale Rückzahlungen: Splid findet stets das einfachste Rückzahlungsmuster“. Android beschreibt ebenfalls minimale Zahlungen. [S2, S3] | Empfänger und Betrag müssen aus derselben Ausgleichsberechnung stammen. |
| Funktioniert online und offline, ohne Anmeldung | Entwicklerbeschreibungen [S2, S3] | Belegt die Ausgabenverwaltung, aber keine Zahlungsausführung. |

Geprüfte Store-Stände: iOS 1.9.1; Android 1.5.1, dort letztes Update 23.08.2025. Suchmaschinen-KI-Antworten und Nutzerrezensionen wurden nicht als technische Belege verwendet.

## Was PayPal offiziell ermöglicht

PayPal dokumentiert Betrag und Währung direkt im PayPal.me-Pfad: `PayPal.Me/DiaRusso/25` und `PayPal.Me/DiaRusso/25AUD`. Ohne Währungscode wird die Standardwährung des Empfängerkontos verwendet. Für ManaWG sollte deshalb ausdrücklich `EUR` angehängt werden. Beispielmuster: `https://paypal.me/{empfaenger}/12.50EUR`; die konkrete Dezimalübergabe ist vor Veröffentlichung auf den Zielgeräten zu prüfen. [P1]

PayPal.me steht laut PayPal allen Kontotypen offen; **Geschäftskonten können jedoch nur Zahlungen für Waren und Dienstleistungen akzeptieren**. Der Link garantiert daher weder eine persönliche Zahlung noch Gebührenfreiheit. Die Zahlungsart und mögliche Gebühren müssen in PayPal geprüft werden. [P1]

Die deutsche Privatkunden-Gebührenseite nennt für inländische persönliche Zahlungen „Kostenlos (wenn keine Währungsumrechnung erforderlich ist)“. Daraus folgt keine allgemeine Gebührenfreiheit für Ausland, Währungsumrechnung oder geschäftliche Zahlungen. [P2]

In den geprüften PayPal.me-Hilfeinformationen ist keine API für ManaWG beschrieben, die den Erfolg einer beliebigen persönlichen Link-Zahlung zurückmeldet. **Link geöffnet, App-Rückkehr und Nutzerbestätigung sind kein durch PayPal verifizierter Zahlungseingang.** Für diese Lösung daher keine automatische Verbuchung und keine Kennzeichnung „von PayPal bestätigt“ vorsehen. Das ist eine Integrationsgrenze der vorgeschlagenen Lösung, keine Behauptung, dass PayPal keinerlei andere oder vertraglich zugängliche APIs anbietet.

## Abgleich mit dem vorhandenen ManaWG-Code

Am lokalen Checkout geprüft, HEAD `67e52e16`, mit bereits vorhandenen fremden Änderungen. Diese Feststellungen sind Quellcodebefunde, kein Nachweis eines funktionierenden Produktions-Zahlungswegs.

| Vorhanden | Stelle | Konsequenz |
| --- | --- | --- |
| PayPal JS SDK mit `merchant-id`, Order-Erstellung und Capture | `apps/web/src/components/wg/PayPalPaymentButton.tsx` | Der heutige Weg ist ein Checkout, kein einfacher persönlicher Zahlungslink. |
| Orders-v2-API, `purchase_units`, `payee.merchant_id`, Partner-Header und Auth-Assertion | `apps/web/src/core/infra/paypal.ts` | Eine Merchant-ID ist kein PayPal.me-Benutzername. Die Felder dürfen nicht umgedeutet werden. [P3] |
| Profilfeld `paypalMerchantId` | `apps/web/src/components/wg/einstellungen/ProfileTab.tsx`; `apps/web/src/core/db/schema.ts` | Für den vorgeschlagenen Link ein eigenes optionales PayPal.me-Feld vorsehen. |
| Manueller Ausgleich mit Vorschau, erwarteten Anteilen und Idempotency-Key | `apps/web/src/components/wg/DebtSummary.tsx` | Vorhandenen Ausgleichsweg wiederverwenden. Er sagt ausdrücklich: „Es wird kein Geld überwiesen.“ |

Der bestehende Checkout verlangt im UI unter anderem EUR, einen zahlenden aktuellen Nutzer, eine Empfänger-Merchant-ID, Berechtigung und konfigurierte öffentliche Client-/Partner-IDs. Anbieterfreigabe, Empfänger-Onboarding und produktive Funktionsfähigkeit wurden in dieser Recherche nicht geprüft. Ein gespeicherter Merchant-Identifier allein ist kein Beleg dafür.

## Kleinster sinnvoller Implementierungsumfang

1. **Empfängerprofil:** Optionalen PayPal.me-Namen speichern; nur eigene Kontaktdaten ändern lassen. Falls vollständige Links angenommen werden: HTTPS und exakten Host `paypal.me` prüfen, ausschließlich den Namen normalisieren und die Ziel-URL selbst erzeugen. Keine beliebigen Redirect-URLs speichern. Eine syntaktisch gültige Eingabe nicht als verifizierten Kontobesitz darstellen.
2. **Ausgleich anzeigen:** Vor dem Öffnen die bestehende Ausgleichsvorschau laden. Person und Währung daraus verwenden; der Link darf höchstens deren tatsächlich verbuchbaren Betrag (`settleableCents`) enthalten. Dieser kann kleiner als der gesamte Saldo (`netCents`) sein. Bei einer Differenz nur den erklärten, verbuchbaren Betrag anbieten oder die Zahlung blockieren. Zunächst EUR unterstützen. Button „In PayPal öffnen“; ohne hinterlegten Link bleibt der vorhandene manuelle Ausgleich verfügbar.
3. **Extern bezahlen:** Erst nach Klick PayPal öffnen. Kein SDK und kein API-Schlüssel für diesen Link nötig. Keine WG-Codes, Mitgliedertokens, Ausgabendetails oder Zugangsdaten an den Link anhängen; Referrer unterdrücken. Empfänger und tatsächlichen Betrag in PayPal prüfen lassen.
4. **Zahlung bewusst erfassen:** Nach Rückkehr bleibt die Schuld offen. Separater Button „Bereits bezahlt eintragen“ verwendet die bestehende Vorschau und Idempotenz. Ändert sich der Saldo zwischen Öffnen und Bestätigen, darf nicht stillschweigend der neue Betrag als bezahlt gelten. Tatsächlich gezahlten Betrag mit der ursprünglichen Vorschau abgleichen; bei Abweichung keine automatische Umbuchung. Teilzahlungen nur anbieten, wenn der bestehende Ausgleich sie korrekt verbuchen kann.
5. **Begriffe sauber halten:** Manuell eingetragenen Ausgleich und technisch verifizierten Checkout unterscheiden. Bestehende Orders und deren Capture-/Wiederholungslogik bei einer späteren Umstellung erhalten, bis offene Vorgänge geklärt sind.

Vor Umsetzung nach Repository-Vorgabe eine kleine OpenSpec-Änderung anlegen. Kein paralleles zweites Schuldenbuch und keine neue Zahlungsbibliothek nötig.

## Abnahmekriterien für eine spätere Umsetzung

- Gültiger Empfänger und positiver Cent-Betrag erzeugen den erwarteten EUR-Link; fremde Hosts, leere Namen und ungültige Beträge werden abgewiesen.
- Bei `settleableCents < netCents` kann der Link niemals den unverbuchbaren Rest einschließen; ohne gültige Vorschau ist er nicht verfügbar.
- Öffnen, Abbruch, Rückkehr und Seitenneuladen verbuchen keinen Ausgleich.
- Ausdrückliches Bestätigen verbucht exakt die geprüften Anteile einmal; Wiederholung und parallele Bestätigung erzeugen keine Doppelbuchung.
- Geänderter Saldo oder Empfänger nach dem Öffnen führt zu erneuter Prüfung statt einer Buchung des falschen Betrags.
- iPhone/Safari und Android/Chrome prüfen: PayPal installiert/nicht installiert, angemeldet/abgemeldet, Dezimalbetrag/Währung, Abbruch und Rückkehr. Ein UI-Test ohne echte Zahlung beweist nur Navigation; tatsächlichen Geldfluss und Eingang getrennt nachweisen.

## Primärquellen

- **S1:** [Splid – offizielle deutsche Website](https://splid.app/german), live gelesen am 27.09.2026.
- **S2:** [Splid – Apple App Store, Entwicklerbeschreibung](https://apps.apple.com/de/app/splid-abrechnen-mit-freunden/id991473495), live gelesen am 27.09.2026.
- **S3:** [Splid – Google Play, vollständige Entwicklerbeschreibung](https://play.google.com/store/apps/details?id=splid.teamturtle.com.splid), live gelesen am 27.09.2026.
- **P1:** [PayPal DE: Was ist PayPal.Me?](https://www.paypal.com/de/cshelp/article/was-ist-paypalme-help432), live geprüft am 27.09.2026; Betrag, Währung und Kontotypen.
- **P2:** [PayPal DE: Privatkunden-Gebühren](https://www.paypal.com/de/digital-wallet/paypal-consumer-fees), live geprüft am 27.09.2026; Seitenstand 07.09.2026.
- **P3:** [PayPal Orders v2 API](https://developer.paypal.com/api/orders/v2), offizielles API-Verzeichnis; dient der Einordnung des vorhandenen Checkout-Codes, nicht als Beleg für Splids Implementierung.
- **P4:** [PayPal: How Log in with PayPal works](https://developer.paypal.com/log-in/how-it-works), live gelesen am 27.09.2026, Seitenstand 14.09.2026; bestehende App-Konten lassen sich mit PayPal verbinden.
- **P5:** [PayPal: Integrate Log in with PayPal](https://developer.paypal.com/log-in/build/), live gelesen am 27.09.2026; Einrichtung, Code-Austausch, Userinfo und verpflichtende Live-App-Prüfung.
- **P6:** [PayPal DE: Wie kann ich Geld senden?](https://www.paypal.com/de/cshelp/article/wie-kann-ich-geld-senden--help293), offizieller Link zu „Senden und anfordern“; Login-Weiterleitung am 27.09.2026 zusätzlich im Browser geprüft.
- **P7:** [PayPal: Seller onboarding](https://developer.paypal.com/platforms/seller-onboarding), live geprüft am 27.09.2026; Checkout unterstützt persönliche Konten nach Verkäufer-Onboarding, Identity-Login allein reicht nicht.
