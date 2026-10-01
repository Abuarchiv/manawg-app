# PayPal-Kontoverknüpfung und Ausgleich

Der Empfänger verbindet sein Konto über „PayPal verbinden“. Anmeldung, Kontoprüfung und Zahlungsoptionen bleiben bei PayPal. ManaWG fragt keine Merchant-ID oder PayPal.me-Adresse ab und speichert keine PayPal-Passwörter.

Der Zahler verwendet „Mit PayPal ausgleichen“. Die vorhandene Orders/Capture-Anbindung verbucht erst den serverseitig bestätigten erfolgreichen Capture. Eine Rückkehr, ein Abbruch oder die Zustimmung im PayPal-Fenster allein begleicht keine Schuld. Manueller Ausgleich bleibt verfügbar.

## Betreiber-Konfiguration

PayPal muss ManaWG als Plattformpartner zulassen; benötigt wird eine Platform REST App. Reines „Log in with PayPal“ verknüpft Identitäten, erteilt aber keine Zahlungsberechtigung für einen Empfänger. Die Verknüpfung verwendet deshalb die offizielle Partner-Referrals-Anbindung.

| Einstellung | Bedeutung |
| --- | --- |
| `PAYPAL_ENV` | `sandbox` für Tests oder `live` für Produktion |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Serverseitiger Zugang der Plattform-App |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | Passende öffentliche Client-ID für den Checkout |
| `PAYPAL_PARTNER_ATTRIBUTION_ID` / `NEXT_PUBLIC_PAYPAL_PARTNER_ATTRIBUTION_ID` | Passender PayPal-BN-Code |
| `PAYPAL_PARTNER_MERCHANT_ID` | Händlerkennung des Plattformbetreibers, nicht eines WG-Mitglieds |
| `NEXT_PUBLIC_APP_URL` | Vertrauenswürdiger Ursprung der jeweiligen Umgebung |

Der Rückweg ist `<NEXT_PUBLIC_APP_URL>/api/paypal/return?state=<zufällige Versuchskennung>`. Der WG-Einladungscode verbleibt im signierten HttpOnly-Cookie und wird nicht an PayPal übermittelt. PayPal erhält eine stabile pseudonyme Kundenkennung; jeder Verbindungsversuch hat zusätzlich eine zufällige Kennung. Die Rückkehr prüft diese Kennung und leitet nur weiter; der anschließende authentifizierte Bestätigungsaufruf prüft Provider-Daten und speichert die Kontozuordnung.

PayPal entscheidet, welche Konten und Produkte im jeweiligen Land zugelassen sind. Die aktuelle Länderübersicht führt Deutschland für Casual/Personal Seller bei PayPal Checkout nicht als verfügbar. Die App verspricht deshalb weder Privatkonto-Unterstützung für jedes Land noch Gebührenfreiheit oder eine Freunde-und-Familie-Überweisung. Gegebenenfalls verlangt PayPal weitere Kontoangaben oder ein Geschäftskonto.

## Freischaltung und Nachweis

1. Plattformfreigabe und Platform REST App im PayPal-Entwicklerkonto einrichten. Geheimnisse ausschließlich in den jeweiligen geschützten Umgebungsvariablen hinterlegen, nicht in Git oder Chat.
2. Sandbox-Zugänge nur in Preview/Test verwenden; öffentlichen Client und serverseitige App konsistent konfigurieren. Live-Zugänge nur in Production.
3. Kontoverknüpfung im Sandbox-Browser mit Rückkehr, Abbruch, fehlender Einwilligung und unvollständiger Freigabe prüfen.
4. Sandbox-Zahlung ausführen und den tatsächlichen Capture samt Empfänger, Betrag, Währung und einmaliger Saldoänderung prüfen. Einen zweiten Versuch sowie Abbruch/Fehler ohne Zahlung prüfen.
5. Erst danach die vorhandenen Release-Gates verwenden. Lokale Fixture-Tests ersetzen keinen Provider- oder Produktionsnachweis.

Am 27.09.2026 wurden bei Vercel die Namen der Umgebungsvariablen geprüft: Production und Preview enthielten keine `PAYPAL_*` oder `NEXT_PUBLIC_PAYPAL_*`-Konfiguration. Production hatte `NEXT_PUBLIC_APP_URL`, Preview nicht. Lokale Hauptcheckout-Umgebungsdateien enthielten ebenfalls keine der geprüften PayPal-Zugangsvariablen. Werte wurden nicht abgerufen. Dieser historische Befund betrifft fehlende Host-Variablen. Die vorhandenen lokalen Sandbox-Zugänge wurden später separat mit tatsächlichem OAuth und Verkäufer-Readiness geprüft; ein gehosteter PayPal-Ablauf bleibt ohne Host-Konfiguration offen.

## Früherer Zwischenstand vor Verkäuferabschluss am 30.09.2026

Der Betreiber hat die Erstellung der US Sandbox Platform Partner App einschließlich des angezeigten Developer Agreement ausdrücklich freigegeben. Die App wurde am 28.09. erstellt; dabei erzeugte PayPal ein Sandbox-Geschäftskonto und neue API-Zugänge. Die Zugangsdaten liegen ausschließlich im privaten lokalen Secret-Verzeichnis. Es wurde keine Live-App eingerichtet.

Die unveränderten App-Helfer erhielten beim Sandbox-OAuth HTTP 200 und beim Partner-Referral HTTP 201. Merchant-Readiness gab vor abgeschlossenem Verkäufer-Onboarding HTTP 401 `AUTHORIZATION_ERROR` zurück. Das ist ein offener Provider-Nachweis, keine bestätigte fehlende Verbindung und kein Grund, die Readiness-Prüfung abzuschwächen.

Eine isolierte lokale PostgreSQL-17.11-Datenbank mit allen 18 Migrationen und einem lokalen Auth-Double ist vorbereitet. Die tatsächlichen App-Routen erstellten eine Test-WG, Verkäufer/Zahler und eine EUR-12,34-Ausgabe; signierte Mitgliedstokens stammen aus dem echten WG-Lookup. Das ist lokaler Handler-Nachweis, kein gehosteter Supabase-Auth-Nachweis.

Der Browser erreichte aus „PayPal verbinden“ den echten Dialog auf `www.sandbox.paypal.com`; Deutschland und das vorhandene deutsche Sandbox-Verkäuferkonto sind auswählbar. Die Verkäuferfreigabe wurde am 30.09. ausdrücklich autorisiert und im Sandbox-Dialog ausgeführt. PayPal verlangt anschließend weitere synthetische Onboardingangaben; diese sind noch kein abgeschlossener Readiness-Nachweis. Readiness nach Rückkehr und echter Sandbox-Capture bleiben bis zum nachgewiesenen Abschluss offen. Ein vorhandenes deutsches Sandbox-Zahlerkonto wird verwendet; zusätzliche Konten sind nicht erforderlich.

## Offizielle Quellen

- [Empfänger vor einer Zahlung verbinden](https://developer.paypal.com/platforms/seller-onboarding/before-payment)
- [Partner-Referrals-Spezifikation](https://developer.paypal.com/api/partner-referrals/v2/schema.json)
- [Onboarding und Länderunterstützung](https://developer.paypal.com/platforms/seller-onboarding)
- [Plattformfreigabe](https://developer.paypal.com/platforms/get-started)
- [Plattformkonto einrichten](https://developer.paypal.com/platforms/create-account)

## Tatsächliches Verkäufer-Onboarding am 30.09.2026

Die separat freigegebene Verkäuferberechtigung wurde im Sandbox-Dialog übernommen. Die weiteren Angaben waren ausschließlich synthetische Testangaben; es wurden kein Live-Konto und kein Bankkonto verknüpft. PayPal meldet den Verkäufer als mit der Plattform verbunden. Die unveränderte Readiness-Prüfung erhielt danach HTTP 200 und `true`.

Der erste vollständige Sandbox-Dialog bot keinen Rücksprung zur HTTP-Loopback-App. Ein gezielter Versuch mit zusätzlicher offizieller Rückkehrbeschriftung änderte dieses Verhalten nicht; die experimentelle Änderung wurde vollständig verworfen. Damit sind App-Zuordnung, echter Browser-Callback und Capture weiterhin offen. Ein geschützter Cloudflare-HTTPS-Test wurde ausdrücklich für höchstens 30 Minuten freigegeben und gestartet. Der öffentliche Zugang wies Anfragen ohne Zugangsschlüssel mit HTTP 401 ab. Nach einer Korrektur des macOS-CLI-Pfads wurde nur innerhalb derselben festen Frist erneut gestartet. Der Supervisor beendete den Zugang um 13:57:39 UTC vor der Frist 13:57:44 UTC. Modellzugangsfehler unterbrachen den weiteren Testaufbau; echter Callback, Mitgliedszuordnung und Zahlung wurden nicht bestätigt. Für ein neues öffentliches Testfenster ist eine gesonderte Freigabe erforderlich. Es gab keine Änderung des Zertifikatsvertrauens und keine TLS-Ausnahme.

## Separater Main-Abgleich am 30.09.2026

Die Sandbox wurde bereits in einer vorherigen Sitzung eingerichtet. Die vorhandenen Plattformzugangsdaten sowie Verkäufer- und Käufer-Testkonten liegen in owner-only Dateien; in dieser Prüfung wurden sie weder ausgegeben noch geändert. Der aktuelle Kandidat `cca08ac6` wurde mit diesen bestehenden Zugangsdaten geprüft: OAuth antwortete mit HTTP 200, der Verkäufer-Readiness-Aufruf mit HTTP 200 und `isPayPalMerchantReady` mit `true`.

Ein älterer Prüf-Wrapper lieferte HTTP 401, weil er die Partner-Händlerkennung als Zielverkäufer übergab. Der Readiness-Aufruf erwartet die Händlerkennung des verbundenen Verkäufers. Die 401 ist daher ein Fehler in diesem Prüfaufruf, kein Nachweis für fehlende Sandbox-Zugänge oder einen Fehler im aktuellen Kandidaten.

Ein neuer Entwickler-Dashboard-Tab führte zwar zur PayPal-Anmeldeseite; das widerlegt die bereits vorhandene Sandbox-Berechtigung nicht. Der Vercel-Namensreadback vom 30.09.2026 zeigte weiterhin keine `PAYPAL_*`- oder `NEXT_PUBLIC_PAYPAL_*`-Variablen in Production oder Preview. Es wurden keine Variablen deployt. Ein echtes Sandbox-Order/Approval/Capture-Ergebnis steht noch aus; Production bleibt ohne PayPal-Konfiguration.

## Offizielle Quellen

- [Empfänger vor einer Zahlung verbinden](https://developer.paypal.com/platforms/seller-onboarding/before-payment)
- [Partner-Referrals-Spezifikation](https://developer.paypal.com/api/partner-referrals/v2/schema.json)
- [Onboarding und Länderunterstützung](https://developer.paypal.com/platforms/seller-onboarding)
- [Plattformfreigabe](https://developer.paypal.com/platforms/get-started)
- [Plattformkonto einrichten](https://developer.paypal.com/platforms/create-account)

Dieser separate Abgleich ergänzt die oben belegte Händler-Readiness; er bestätigt keinen App-Callback oder Capture. Der aktuelle lokale Produktstand ist `a5733ba`; die PayPal-Backend-Module stimmen mit dem unveränderten Sandbox-Handlerstand überein.

## Verifizierter lokaler App-Ablauf am 30.09.2026

Die zweite öffentliche HTTPS-Freigabe wurde abgelehnt; der Testzugang bleibt geschlossen. Die aktuelle offizielle Multiparty-Anleitung unterstützt den Status-GET mit der Tracking-ID. Die echte Sandbox-Antwort ist ein einzelnes Objekt mit merchant_id, tracking_id und links; Tracking-ID und kanonische Händler-Readiness stimmen. Der geprüfte Produktstand 14995d0 ergänzt dafür die vorhandene Connect-POST-Route um die strikte Aktion complete. Sie akzeptiert keine frei wählbare Händlerkennung: aktuelles gültiges signiertes Cookie, angemeldeter Nutzer, WG/Mitglied, Umgebung, Ablaufzeit, aktuell abgeleitete Tracking-ID und bisherige Händlerbindung werden geprüft; die bestehenden Readiness-, Callback- und CAS-Prüfungen bleiben erhalten. Der normale Status-GET schreibt weiterhin nichts.

Der echte Browser zeigte danach „PayPal verbunden“. Mit dem bestehenden synthetischen Zahler wurde eine neue 12,34-EUR-Testschuld über die normalen App-Routen angelegt; eine fremd bereits manuell beglichene alte Testausgabe blieb erhalten. Der echte SDK-Checkout-Abbruch änderte den Saldo nicht. Die anschließende Sandbox-Freigabe und der App-Capture hinterließen genau eine abgeschlossene Zahlung über 1234 Cent/EUR für den erwarteten Zahler, Empfänger und Sandbox-Händler; die App zeigt null Saldo. Ein geprüfter erneuter App-Capture derselben bereits abgeschlossenen Bestellung liefert 200/COMPLETED, ohne neue Provider-Anfrage oder zusätzliche Zeile und ohne Änderung von Abschlusszeit und Saldo. Keine Live-Zahlung, kein gefälschter Callback und keine manuelle Händler-Datenbankzuweisung wurden verwendet.

Diese Prüfung verwendet tatsächliche PayPal-Sandbox-APIs und SDK sowie reale lokale App-Routen/SQL, aber ein erklärtes lokales Auth-Double. Der echte HTTPS-Callback, gehostete Auth-/Device-Strecken sowie die Live-Freigabe bleiben davon getrennt.
