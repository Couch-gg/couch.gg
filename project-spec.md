# Project Spec: Couch Multiplayer Game Platform

Arbeitsname: **Couch Games**  
Status: aus Signal-Sprachnachrichten verdichtete Produkt- und Umsetzungsspezifikation  
Datum: 2026-06-13

## 1. Produktidee

Couch Games ist eine browser- und TV-basierte Multiplayer-Plattform für kurze gemeinsame Spiele im selben Raum. Ein großer Bildschirm zeigt die Lobby und das laufende Spiel; die Handys der Spieler werden durch Scannen eines QR-Codes zu Controllern.

Das Produkt soll sich wie eine digitale Alternative zu Gesellschafts-, Karten- oder Partyspielen anfühlen: Menschen sitzen gemeinsam auf dem Sofa, öffnen eine Lobby auf Fernseher, Laptop oder Beamer, scannen mit ihren Handys einen QR-Code und können sofort spielen.

## 2. Kernprinzipien

- Spiele laufen nicht primär auf dem Handy. Das Handy ist immer Controller.
- Der große Bildschirm ist die gemeinsame Spieloberfläche.
- Einstieg erfolgt ohne Account-Zwang über QR-Code oder teilbaren Link.
- Jede Lobby hat eine eindeutige URL.
- Die Plattform enthält ausschließlich Multiplayer-Spiele.
- Spiele sollen kurz, niedrigschwellig und sofort verständlich sein.
- Die Plattform soll später auch AI-/Vibe-Coding-Spiele aufnehmen können.

## 3. Zielgruppen

Primär:
- Freundesgruppen auf dem Sofa
- Paare, WGs, Familien, kleine Partys
- Menschen, die spontan ein digitales Partyspiel spielen wollen, ohne App-Setup und Controller

Sekundär:
- Remote-Freunde, die jeweils einen Laptop/Screen nutzen und mit dem Handy steuern
- Entwickler oder Creator, die kleine Multiplayer-Spiele einreichen
- AI-/Vibe-Coding-Nutzer, die schnell neue Couch-Games erstellen wollen

## 4. MVP-Ziele

Der MVP muss zeigen, dass das zentrale Spielgefühl funktioniert:

1. Nutzer öffnet Website auf großem Bildschirm.
2. Nutzer erstellt eine Lobby.
3. Plattform zeigt einen QR-Code und einen teilbaren Link.
4. Weitere Spieler scannen den QR-Code und treten der Lobby bei.
5. Jeder Spieler sieht auf dem Handy einen Controller.
6. Host wählt ein Spiel aus.
7. Spiel startet manuell durch Host oder automatisch bei voller Spielerzahl.
8. Spieler steuern das gemeinsame Spiel per Handy.

## 5. Nicht-Ziele für MVP

- Kein vollständiger App-Store für externe Games.
- Kein Login-System.
- Keine komplexe Persistenz von Spielerprofilen.
- Keine native TV-App im ersten Schritt, sofern Browser/Laptop gut funktioniert.
- Kein vollwertiger AI-Game-Builder im MVP.
- Keine allgemeine Mobile-Game-Plattform, bei der jeder auf seinem Handy spielt.

## 6. Plattform-Oberfläche

### 6.1 Startbildschirm

Beim Öffnen der Plattform sieht der Nutzer sofort:

- Button: Neue Lobby erstellen
- Eingabe oder Auswahl: Bestehender Lobby beitreten
- Liste zuletzt/gebookmarkter Lobbys aus lokalem Browser-Speicher
- Spielkatalog/Homescreen mit verfügbaren Multiplayer-Spielen

Es soll kein schwerer Onboarding-Flow davor liegen.

### 6.2 Lobby-Erstellung

Wenn ein Nutzer eine Lobby erstellt:

- System erzeugt eindeutige Lobby-ID und URL.
- Modal zeigt QR-Code.
- Modal bietet Share-Button für URL.
- Lobby erhält einen einfachen, merkbaren Anzeigenamen.
- Erster beitretender Spieler wird automatisch Host.

### 6.3 Lobby-Ansicht

Die Lobby ist kein eigener schwerer Bereich, sondern eher ein Overlay/Status rund um den Spiele-Homescreen:

- Oben: Lobbyname, Spielerzahl, Host-Indikator
- Mitte: Spielkatalog oder laufendes Spiel
- Unten/seitlich: kleine Chatbox oder Aktivitätsfeed
- QR-/Share-Funktion bleibt erreichbar

## 7. Spielerbeitritt

Spieler treten grundsätzlich über QR-Code oder denselben Link bei.

Flow:

1. Spieler scannt QR-Code mit Handy.
2. Handy öffnet Controller-Web-App oder native Controller-App.
3. Spieler gibt optional Anzeigenamen ein.
4. Spieler erscheint in Lobby.
5. Controller bleibt mit Lobby und späterem Spiel verbunden.

Wenn der Link remote geteilt wird, kann er zunächst wieder einen QR-Code anzeigen, damit das Handy als Controller gekoppelt werden kann.

## 8. Host-Regeln

- Der erste beitretende Spieler wird Host.
- Host kann ein Spiel auswählen.
- Host kann das Spiel starten, sobald Mindestspielerzahl erreicht ist.
- Wenn die Maximalspielerzahl des gewählten Spiels erreicht ist, startet das Spiel automatisch.
- Host-Funktionalität bleibt minimal: auswählen, starten, eventuell Spiel zurücksetzen.

Offene Designfrage:
- Was passiert, wenn der Host disconnectet? Vorschlag: nächster beigetretener Spieler wird Host.

## 9. Controller-Konzept

Das Handy ist immer Controller, nie primäre Spielanzeige.

Controller-Anforderungen:

- Läuft mindestens als mobile Web-App.
- Später optional native iOS-/Android-App.
- Verbindet sich per Lobby-Token.
- Zeigt spielabhängige Eingabeelemente.
- Verhindert Zoom-/Scroll-Probleme.
- Bleibt bei Display-Sleep möglichst stabil.

Controller-Modi:

- MVP: universeller Controller im PlayStation-Stil
  - D-Pad oder Joystick
  - A/B/X/Y oder 2-4 Aktionsbuttons
  - Start/Back optional
- Später: Spiel-spezifische Controller-Layouts
  - Joystick
  - Pfeiltasten
  - Reaktionsbutton
  - Karten-/Auswahlhand
  - Slider, Drehregler, Textinput

## 10. Screen-/TV-Konzept

Priorität:

1. Browser-Version für Laptop/Desktop/Beamer
2. Browser auf Smart-TV, sofern praktikabel
3. Native Android-TV-App
4. Weitere TV-Plattformen nach Validierung

Grundannahme:
Das Produkt wird für physisches Zusammenspielen am großen Bildschirm geframed. Remote-Spiel bleibt möglich, aber nicht der primäre Pitch.

## 11. Game-Katalog

Die Plattform zeigt nur Multiplayer-Spiele.

Jedes Spiel definiert:

- Titel
- Beschreibung
- Mindestspielerzahl
- Maximalspielerzahl
- Controller-Layout
- Spiel-Entry-Point
- unterstützte Bildschirmseitenverhältnisse
- geschätzte Rundendauer
- Status: intern, eingereicht, veröffentlicht

Für den MVP reichen 1-3 eigene Spiele, damit Plattform und Controller-Paradigma validiert werden.

## 12. Game-Runtime

Spiele laufen als eingebettete Apps innerhalb der Plattform.

MVP-Architektur:

- Shell-App verwaltet Lobby, Spieler, Verbindungen und Spielauswahl.
- Game-App bekommt eine Runtime-API.
- Controller sendet Input-Events an Lobby/Game-Server.
- Game-App rendert auf dem großen Bildschirm.
- Game-State liegt serverseitig oder in einer autoritativen Game-Session.

Runtime-API, erste Skizze:

~~~ts
type Player = {
  id: string;
  name: string;
  joinedAt: string;
  isHost: boolean;
};

type GameManifest = {
  id: string;
  title: string;
  minPlayers: number;
  maxPlayers: number;
  controllerLayout: ControllerLayout;
};

type ControllerEvent = {
  playerId: string;
  type: "button" | "axis" | "text" | "gesture";
  control: string;
  value: unknown;
  timestamp: number;
};
~~~

## 13. Lobby- und Verbindungsarchitektur

Empfohlener MVP:

- Web-App mit Echtzeitkanal über WebSocket.
- Lobby-Server hält temporären State.
- Lobby-IDs sind kurzlebig und zufällig.
- Clients reconnecten über Lobby-ID und Player-Token.
- Keine Accounts notwendig.

Datenobjekte:

- Lobby
- Player
- Device
- GameSession
- GameManifest
- ControllerLayout
- ChatMessage

## 14. Datenmodell

~~~ts
type Lobby = {
  id: string;
  slug: string;
  name: string;
  hostPlayerId: string | null;
  createdAt: string;
  expiresAt: string;
  currentGameId: string | null;
  state: "waiting" | "playing" | "ended";
};

type Device = {
  id: string;
  playerId: string;
  lobbyId: string;
  role: "controller" | "screen";
  connectedAt: string;
  lastSeenAt: string;
};

type GameSession = {
  id: string;
  lobbyId: string;
  gameId: string;
  state: "ready" | "running" | "finished";
  startedAt: string | null;
  endedAt: string | null;
};
~~~

## 15. Wichtige User Stories

### US-01: Neue Lobby erstellen

Als Nutzer möchte ich auf dem großen Bildschirm eine neue Lobby erstellen, damit meine Freunde schnell beitreten können.

Akzeptanzkriterien:
- QR-Code wird angezeigt.
- Link kann geteilt werden.
- Lobby ist ohne Account nutzbar.
- Erster Spieler wird Host.

### US-02: Per Handy beitreten

Als Spieler möchte ich den QR-Code scannen und sofort als Controller verbunden sein.

Akzeptanzkriterien:
- Handy zeigt Controller.
- Spieler erscheint auf dem großen Bildschirm.
- Verbindung bleibt beim Spielstart bestehen.

### US-03: Spiel starten

Als Host möchte ich ein Spiel auswählen und starten.

Akzeptanzkriterien:
- Nur spielbare Games sind startbar, wenn Mindestspielerzahl erreicht ist.
- Bei Maximalspielerzahl startet das Spiel automatisch.
- Controller-Layout wird passend geladen.

### US-04: Remote-Link

Als Nutzer möchte ich einen Lobby-Link verschicken, damit jemand remote beitreten kann.

Akzeptanzkriterien:
- Link öffnet eine Beitrittsseite.
- Beitrittsseite kann erneut QR-Code zeigen.
- Handy bleibt Controller.
- Spiel läuft weiterhin auf einem größeren Screen.

## 16. AI-/Vibe-Coding-Erweiterung

Später kann die Plattform erlauben, direkt aus der Lobby heraus neue Spiele zu erstellen.

Vision:
- Freunde sitzen auf dem Sofa.
- Sie beschreiben ein Spiel in natürlicher Sprache.
- System generiert ein spielbares Couch-Game.
- Presets helfen bei Genres und Engines.

Mögliche Presets:
- Reaktionsspiel
- Quiz
- Jump'n'Run
- Arena/Duell
- Zeichnen/Raten
- Rhythmusspiel
- Kartenspiel-Variante

Für den Anfang sollte diese Funktion nur als separater Experiment-Bereich gedacht werden, nicht als MVP-Abhängigkeit.

## 17. Technische Empfehlung für MVP

Frontend:
- Web-App für Screen und Controller
- Responsive, aber getrennte Rollen: Screen View und Controller View

Backend:
- Node/TypeScript Realtime-Server
- WebSocket oder Socket.IO
- Temporäre Lobby-State-Persistenz

Game Runtime:
- JavaScript/TypeScript Games
- Manifest pro Game
- Event-basierte Controller-Eingaben

Hosting:
- Web-first
- Später Packaging für TV-Plattformen prüfen

## 18. MVP-Schnitt

Phase 1:
- Lobby erstellen und beitreten
- QR-Code und Share-Link
- Spielerlisten
- Controller-Verbindung
- Dummy-Game mit Button-Input

Phase 2:
- Erstes echtes Partyspiel
- Host-Start und Auto-Start
- Controller-Layout-Konfiguration
- Reconnect

Phase 3:
- Game-Katalog
- 2-3 weitere Spiele
- Remote-Join polish
- Basis-Chat oder Aktivitätsfeed

Phase 4:
- Spiel-Einreichung oder AI-Game-Prototyping
- TV-App-Strategie

## 19. Offene Fragen

- Soll der Controller im MVP nur Web sein oder sofort als native App vorbereitet werden?
- Welche TV-Plattform ist zuerst relevant: Browser, Android TV, Apple TV, Fire TV?
- Wie lange leben Lobbys?
- Braucht der Chat im MVP echte Nachrichten oder reicht ein Aktivitätsfeed?
- Welche 1-3 Spiele eignen sich am besten als Proof of Concept?
- Wie wird ein externer Game-Submit technisch und sicher isoliert?
- Wie stark soll Remote-Spiel im ersten Pitch sichtbar sein?
- Arbeitsname: eher Sofa/Couch-Marke oder neutraler Game-Plattform-Name?

## 20. Erste Umsetzungsempfehlung

Nicht mit TV-App oder AI-Game-Builder anfangen. Der schnellste überzeugende Prototyp ist:

1. Screen-Web-App mit Lobby und QR-Code.
2. Mobile Controller-Web-App.
3. WebSocket-Lobby-Server.
4. Ein simples Echtzeitspiel, das ohne Erklärung funktioniert.
5. Danach erst Game-Katalog und Controller-Layout-System abstrahieren.

Wenn dieser Kern Spaß macht, tragen die späteren Ideen: TV-Packaging, Game-Submission und Vibe-Coding direkt auf dem Sofa.
