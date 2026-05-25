import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DEFAULT_RAKE_PERCENT } from './constants/app';
import {
  CHAT_BUTTON_BOTTOM,
  PLATFORM_HEADER_TOP,
  TABLE_MAX_HEIGHT,
} from './designSystem';
import { ActionButtons, PostOpenButtons, SpectatorBar } from './features/gameRoom/components/Actions';
import { AnteOverlay } from './features/gameRoom/components/AnteOverlay';
import { BetOverlay } from './features/gameRoom/components/BetOverlay';
import { CenterDeck, FoldingSeatOverlay } from './features/gameRoom/components/Cards';
import { ChatButton, ChatPanel, type ChatPickItem } from './features/gameRoom/components/Chat';
import { GameRoomKeyframes } from './features/gameRoom/components/GameRoomKeyframes';
import { ConfirmExit, GameMenu, Header } from './features/gameRoom/components/Menu';
import { PotView } from './features/gameRoom/components/PotView';
import { RaiseSheet } from './features/gameRoom/components/RaiseSheet';
import { SeatsLayer, type SeatsLayerSeat } from './features/gameRoom/components/SeatsLayer';
import {
  SvaraBanner,
  type SvaraDecision,
  type SvaraPhase,
} from './features/gameRoom/components/SvaraBanner';
import { Table } from './features/gameRoom/components/Table';
import { WinnerChipsOverlay } from './features/gameRoom/components/WinnerChipsOverlay';
import {
  ANTE_CHIP_DURATION_MS,
  ANTE_CHIP_STAGGER_MS,
  CARDS_PER_SEAT,
  DEAL_STAGGER_MS,
  getAnteTotalMs,
  getThemeColors,
  HAND_ENTER_DURATION_MS,
  HAND_FOLD_FLIGHT_MS,
  HAND_FOLD_TOTAL_MS,
  type SeatAnchorPos,
  SEATS_DEFAULT,
  TABLE_PRESETS,
} from './features/gameRoom/constants';
import { type Card,dealHand, preloadCardImages, svaraHandScore } from './features/gameRoom/deck';
import { useBodyScrollLock } from './features/gameRoom/hooks/useBodyScrollLock';
import { useChatReactions } from './features/gameRoom/hooks/useChatReactions';
import { useGameSettings } from './features/gameRoom/hooks/useGameSettings';
import { type RotationSeat,useSeatRotation } from './features/gameRoom/hooks/useSeatRotation';
import { useTgBackButton } from './features/gameRoom/hooks/useTgBackButton';
import { playCardFlickSound, playCardOpenSound, playPokerChipSound, playSvaraAnnounceSound, playTurnStartSound, playWinnerSound } from './features/gameRoom/sounds';
import styles from './GameRoom.module.css';
import { sendChatMessage, sendGameAction, subscribeToChat, subscribeToGameState } from './services/gameSocket';
import { hapticTap } from './services/haptics';
import { getTelegramUserId, getTelegramWebApp, shareToTelegram } from './services/telegram';
import { useAuthStore } from './store/authStore';
import { useGameStore } from './store/gameStore';

type Theme = 'light' | 'dark';
type ThemePref = 'light' | 'dark' | 'system';

export interface GameRoomRoom {
  id?: number | string;
  num: number;
  players?: number;
  max?: number;
  password?: string;
  rakePercent?: number;
  code?: string;
}

export interface GameRoomProps {
  room: GameRoomRoom;
  onExit: () => void;
  onSetThemePref?: (pref: ThemePref) => void;
  onTakeSeat?: (seat: RotationSeat | { pos: SeatAnchorPos } | null) => void;
  waitForNextRound?: boolean;
  themePref?: ThemePref;
  blindAmount?: number;
  theme?: Theme;
  spectator?: boolean;
}

interface FoldingEntry {
  displayPos: SeatAnchorPos;
}

type FoldingMap = Record<string, FoldingEntry>;

// ── Turn-timer constants ────────────────────────────────────────────
const TURN_DURATION_MS = 15_000;
// Small delay after deal animation finishes before the timer starts.
const TURN_START_DELAY_MS = 800;

// How long to wait after the showdown flip before the big SVARA splash
// appears on the felt. Tied score-chips/badges flip into the SVARA tie
// state immediately (so they animate in already gold + pulsing), but the
// on-table splash is delayed by ~1s so the player gets a beat to read
// everyone's cards before the title takes over the felt.
const SVARA_REVEAL_DELAY_MS = 1000;

interface BetFlight {
  id: number;
  seatId: string;
  chipCount: number;
  slotStart: number;
}

function getBetChipCount(amount: number): number {
  if (amount <= 5) return 1;
  if (amount <= 10) return 2;
  if (amount <= 20) return 3;
  if (amount <= 50) return 4;
  if (amount <= 100) return 5;
  if (amount <= 200) return 6;
  if (amount <= 1000) return 8;
  return 10;
}

const MAX_VISIBLE_BET_PILE_SLOTS = 18;

// Per-seat demo ante value. Mirrors the mock pot calc lower in this file
// (`seats * 10`) so the bank readout, the winner badge, and the count-down
// sweep all stay in lock-step until the backend supplies a real `pot`.
const ANTE_PER_SEAT_DEMO = 10;

/**
 * GameRoom — top-level table screen.
 *
 * Decomposed into:
 *   - hooks/useSeatRotation       — seating state machine
 *   - hooks/useChatReactions      — per-seat reactions + WebAudio
 *   - hooks/useGameSettings       — persistent felt / sound / vibration
 *   - hooks/useTgBackButton       — Telegram BackButton confirm-exit
 *   - hooks/useBodyScrollLock     — scroll-lock the document while mounted
 *   - components/Table            — pill-shaped felt with rails & gloss
 *   - components/PotView          — center bank readout + waiting pill
 *   - components/SeatsLayer       — memoized seat list
 *   - components/GameRoomKeyframes — global @keyframes used by the table
 *   - Header / GameMenu / ConfirmExit / CenterDeck / ChatPanel / ActionButtons
 */
export default function GameRoom({
  room,
  onExit,
  onSetThemePref,
  onTakeSeat,
  waitForNextRound = false,
  themePref = 'dark',
  blindAmount = 20,
  theme = 'dark',
  spectator = false,
}: GameRoomProps) {
  const chatVariant = useMemo<'ghost' | 'soft' | 'blue'>(() => {
    try {
      const url = new URL(window.location.href);
      const v = url.searchParams.get('chatbtn');
      if (v === 'ghost' || v === 'soft' || v === 'blue') return v;
      return 'soft';
    } catch {
      return 'soft';
    }
  }, []);

  // Real local-user profile (Telegram-authenticated). Painted onto the
  // me-seat so the bottom nameplate shows the actual logged-in player
  // instead of the positional placeholder from `SEATS_DEFAULT`.
  const authUser = useAuthStore((state) => state.user);
  const realSeats = useGameStore((state) => state.seats);
  // Canonical phase / round metadata pushed by the server (translated by
  // `svaraAdapter.ts` → `gameSocket.handleSnapshot` → `applySnapshot`).
  // `version` doubles as a "have we received any snapshot yet?" flag —
  // the realtime slice starts at 0 and the bridge mints version 1 on the
  // first applied snapshot, so `version > 0` means the wire is in charge.
  const serverPhase = useGameStore((state) => state.phase);
  const serverStateVersion = useGameStore((state) => state.version);
  const serverDriven = serverStateVersion > 0;
  // Server-side seat id whose turn it currently is (translated from
  // `gameState.currentPlayerIndex` by the adapter, then through
  // `applySnapshot` into the realtime slice). String keyed by the
  // server-side position (`"1"` … `"6"`); `null` outside of the
  // `betting` phases. Local mode (no server) stays at `null` and the
  // legacy `setActiveTurnSeatId` path keeps running.
  const serverActiveSeatId = useGameStore((state) => state.activeSeatId);
  // Server betting metadata, mirrored from `SvaraGameState`. Drives the
  // call / raise / blind-bet amounts so the buttons match the actual
  // server-side `lastActionAmount` / `lastBlindBet`, rather than the
  // static `blindAmount` prop. All four default to 0 until the first
  // snapshot lands — when `serverDriven` is false we ignore them and
  // fall back to the static prop math (mock / preview mode).
  const serverMinBet = useGameStore((state) => state.minBet);
  const serverCurrentBet = useGameStore((state) => state.currentBet);
  const serverLastBlindBet = useGameStore((state) => state.lastBlindBet);
  const serverLastActionAmount = useGameStore((state) => state.lastActionAmount);
  // Server-pushed turn clock. The bet timer below subtracts elapsed
  // wall-clock from this so reconnects don't reset the visible clock
  // to a full 15s.
  const serverTurnStartTime = useGameStore((state) => state.turnStartTime);
  const serverTurnDurationMs = useGameStore((state) => state.turnDurationMs);
  // Authoritative winner from the snapshot — populated when the server
  // computes `state.winners` (showdown / svara resolution). Used to
  // pin the winner overlay to the right seat instead of recomputing
  // from locally-dealt cards via `svaraHandScore` (which doesn't know
  // about the three-7s / two-7s / joker special cases and would
  // disagree with the backend on those hands).
  const serverWinnerSeatId = useGameStore((state) => state.winnerId);

  const mySeatOverlay = useMemo(() => {
    if (!authUser) return null;
    const name =
      authUser.username && authUser.username.trim()
        ? authUser.username
        : authUser.name && authUser.name.trim()
          ? authUser.name
          : 'Player';
    return {
      name,
      stack: `$${authUser.balance.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
      photo: typeof authUser.photo === 'string' && authUser.photo ? authUser.photo : 7,
    };
  }, [authUser]);

  // Clockwise order around the felt starting from the local player's seat.
  // Index 0 is the bottom (where the local user always sits — the table
  // rotates around them so every player sees themselves at the bottom).
  // The remaining anchors run clockwise: right-down → right-up → top →
  // left-up → left-down.
  const ANCHOR_ORDER: SeatAnchorPos[] = useMemo(
    () => ['bottom', 'right-down', 'right-up', 'top', 'left-up', 'left-down'],
    [],
  );

  // Telegram identity of the local user (or `null` outside of the Telegram
  // shell / preview mode). Recomputed via a state subscription so we react
  // when the session bootstraps after the first render.
  const selfTelegramId = useMemo(() => {
    const tg = getTelegramUserId();
    return tg !== null ? String(tg) : null;
  }, []);

  // Server-side position assigned to the local player. We find it by
  // walking `realSeats` for an entry whose `telegramId` matches our own.
  // Server positions are 1..6 (per `useAutoSitDown`); we treat anything
  // outside that range as "unknown" and fall back to no rotation so the
  // demo / spectator views keep working.
  //
  // NOTE: deliberately named `myServerSeatId` to avoid shadowing the
  // separate `mySeatId` further down — that one is the local 1..6 id used
  // by the UI layer (matches `SEATS_DEFAULT[*].id`), whereas this one is
  // the server-side position string ("1".. "6").
  const myServerSeatId = useMemo<string | null>(() => {
    if (!selfTelegramId) return null;
    for (const [seatId, seat] of Object.entries(realSeats ?? {})) {
      if (seat.telegramId && String(seat.telegramId) === selfTelegramId) {
        return seatId;
      }
    }
    return null;
  }, [realSeats, selfTelegramId]);

  // Build the dynamic server-position → table-anchor mapping rotated so
  // that the local player's server position lands at `bottom`. Without
  // this rotation, every client would see the same hard-coded mapping
  // and a player seated at server position 2 would render themselves
  // at `right-up` instead of at the bottom of the table.
  const SEATID_TO_POS: Record<string, SeatAnchorPos> = useMemo(() => {
    const n = ANCHOR_ORDER.length;
    // Numeric server-position offset that lands my seat at index 0
    // (`bottom`). When we don't know my server position yet we use 0
    // so the layout matches the pre-rotation defaults.
    const myPositionNum = myServerSeatId !== null ? Number(myServerSeatId) : NaN;
    const offset = Number.isFinite(myPositionNum) ? myPositionNum : 0;
    const map: Record<string, SeatAnchorPos> = {};
    // Server positions are integers (typically 1..6, but the adapter
    // doesn't constrain the range). We map every position seen in the
    // current snapshot plus the canonical 0..6 range to cover defaults.
    const positions = new Set<number>();
    for (const seatId of Object.keys(realSeats ?? {})) {
      const num = Number(seatId);
      if (Number.isFinite(num)) positions.add(num);
    }
    for (let p = 0; p <= n; p += 1) positions.add(p);
    for (const p of positions) {
      const relIdx = ((p - offset) % n + n) % n;
      map[String(p)] = ANCHOR_ORDER[relIdx];
    }
    return map;
  }, [ANCHOR_ORDER, realSeats, myServerSeatId]);

  // Paint OTHER players' data onto their rotated anchor. The local
  // player's overlay is applied separately via `mySeatOverlay` (always
  // `bottom`), so we explicitly skip our own seat to avoid rendering
  // ourselves in two places at once.
  const otherSeatsOverlay = useMemo(() => {
    const map: Partial<Record<SeatAnchorPos, { name?: string; stack?: string; photo?: string | number }>> = {};
    for (const [seatId, seat] of Object.entries(realSeats ?? {})) {
      // Skip the local player — their data is overlaid on `bottom` by
      // `mySeatOverlay` further up. Comparing by telegramId is the
      // canonical check; falling back to seatId === myServerSeatId covers
      // the brief window before `myServerSeatId` resolves.
      if (selfTelegramId && seat.telegramId && String(seat.telegramId) === selfTelegramId) continue;
      if (myServerSeatId !== null && seatId === myServerSeatId) continue;
      const pos = SEATID_TO_POS[seatId];
      if (!pos || pos === 'bottom') continue;
      // Server balances are floats that often drift past 12 fractional
      // digits (e.g. `$650.999999999999` after a `$1` ante is debited
      // from `$651.00`). Round to two decimals and re-use the same
      // `toLocaleString` formatting `mySeatOverlay` uses so the
      // opponent nameplate doesn't look like a debug printout.
      const stackStr =
        typeof seat.stack === 'number'
          ? `$${seat.stack.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
          : seat.stack;
      map[pos] = {
        name: seat.name,
        stack: stackStr,
        photo: seat.photo,
      };
    }
    return map;
  }, [realSeats, SEATID_TO_POS, selfTelegramId, myServerSeatId]);

  // ── Synthetic deal pulse ────────────────────────────────────────────
  // The svarapro backend transitions from `ante` to `blind_betting`
  // inside a single `publishGameUpdate`, so the client never sees a
  // stable `phase === 'dealing'` window long enough to play the
  // chip-toss + card-fly animation. Detect the `idle | round_end →
  // betting` edge and synthesise a brief `dealing` window locally so
  // the visual still fires for every new round.
  //
  // Suppressed when the first snapshot we see already has
  // `phase === 'betting'` (mid-game reconnect / spectator join) so we
  // don't fake a deal animation over a hand that's been on the felt
  // for several seconds already.
  const [localDealingPulse, setLocalDealingPulse] = useState<boolean>(false);
  const prevServerPhaseRef = useRef<typeof serverPhase | null>(null);
  useEffect(() => {
    if (!serverDriven) {
      prevServerPhaseRef.current = serverPhase;
      return;
    }
    const prev = prevServerPhaseRef.current;
    prevServerPhaseRef.current = serverPhase;
    if (serverPhase !== 'betting') return;
    if (prev !== 'idle' && prev !== 'round_end' && prev !== 'dealing') return;
    setLocalDealingPulse(true);
    // Drop the synthetic pulse after the chip toss + card fly + a
    // turn-start beat. Tuned for 6 seats — caps out at ~5s, which is
    // enough for the animation chain to set `dealingDone = true` on
    // its own. After the pulse drops the forced-dealingDone effect
    // below takes over so the action bar still appears even if the
    // animation timing is off.
    const id = setTimeout(() => setLocalDealingPulse(false), 5200);
    return () => clearTimeout(id);
  }, [serverDriven, serverPhase]);

  // When the wire is the source of truth, deal animation must follow
  // server `status === 'ante'` (mapped to `phase === 'dealing'`) rather
  // than the legacy `DEAL_START_DELAY_MS` setTimeout. `undefined` keeps
  // the local timer alive for tests / no-server demo flows. The
  // `localDealingPulse` lets us paint the animation even when the
  // wire skips the intermediate phase (see above).
  const dealingFromServer = serverDriven
    ? serverPhase === 'dealing' || localDealingPulse
    : undefined;

  const {
    seats,
    getDisplayPos,
    activeDealOrder,
    joinedMidDeal,
    aloneInRoom,
    showDealing,
    handleTakeSeat,
  } = useSeatRotation({
    room,
    spectator,
    waitForNextRound,
    onTakeSeat,
    mySeat: mySeatOverlay,
    otherSeats: otherSeatsOverlay,
    dealingFromServer,
    // Hand the live snapshot's seated-player count to the rotation hook so
    // its `aloneInRoom` / `emptyPositionsBase` checks track who is actually
    // at the table right now. `room.players` is captured once when the user
    // clicked the lobby card and never refreshed for the in-room view, so
    // without this the first player kept seeing every other seat as empty
    // even after a second player sat down.
    serverSeatedCount: serverDriven ? Object.keys(realSeats ?? {}).length : undefined,
  });

  const settings = useGameSettings();
  const t = getThemeColors(theme);
  const telegramPlatform = useMemo<string>(() => {
    const tg = getTelegramWebApp();
    if (tg?.platform) return tg.platform;
    if (typeof navigator === 'undefined') return 'unknown';
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    return 'unknown';
  }, []);
  const isAndroidTelegram = telegramPlatform === 'android';
  const platformPadding = PLATFORM_HEADER_TOP as Record<string, number | undefined>;
  const headerTopPadding =
    platformPadding[telegramPlatform] ?? platformPadding.default ?? 14;

  // Android-only: shrink the open-hand fan (cards + score badge) a touch so
  // it doesn't crowd the felt on smaller Android WebViews. iOS keeps the
  // original sizing. Picked up by `seatHandPositionStyle` in Cards.tsx
  // through `--svr-hand-scale`, which gets composed with each seat's
  // existing transform.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const body = document.body;
    if (!body) return;
    if (isAndroidTelegram) {
      body.style.setProperty('--svr-hand-scale', '0.9');
    } else {
      body.style.removeProperty('--svr-hand-scale');
    }
    return () => {
      body.style.removeProperty('--svr-hand-scale');
    };
  }, [isAndroidTelegram]);

  // Canonical game state lives in the store; the WebSocket bridge writes it
  // when `ROOM_STATE`/`GAME_TICK` arrive. Falls back to 0 / default rake
  // when running without a backend.
  const pot = useGameStore((state) => state.pot);
  const rakePercent = room?.rakePercent ?? DEFAULT_RAKE_PERCENT;

  // Demo pot tracking. The store-driven `pot` stays at 0 until a backend is
  // wired, so we accumulate antes + bets locally and display whichever
  // value is non-zero. During the winner sweep `potCountdown` overrides
  // both so the bank counter visibly ticks down to 0 as chips arrive.
  const localPotRef = useRef<number>(0);
  const [localPot, setLocalPot] = useState<number>(0);
  const [potCountdown, setPotCountdown] = useState<number | null>(null);
  const potCountdownRafRef = useRef<number | null>(null);
  const displayedPot = potCountdown ?? (pot > 0 ? pot : localPot);

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // Local UI toggle until real game state lands over WS — once the player
  // taps «Открыть», swap the bottom panel to the post-open action set.
  const [cardsOpened, setCardsOpened] = useState(false);
  const [raiseOpen, setRaiseOpen] = useState(false);
  // The 3-card hand shown above the me-seat avatar when the player opens.
  // Until a backend is wired we deal a random hand from the 32-card Свара
  // deck once the room mounts (and again every time a fresh round starts).
  const [myHand, setMyHand] = useState<Card[]>(() => dealHand());
  // Showdown — every seat's cards are flipped face-up simultaneously. Until
  // a backend is wired, the demo trigger lives in the game menu («Вскрыть
  // всех (демо)»). Each round resets `seatHands` and re-deals a random
  // 3-card hand per seat so the cards differ from round to round.
  const [seatHands, setSeatHands] = useState<Record<string, Card[]>>({});
  const [showdown, setShowdown] = useState<boolean>(false);
  // Seats currently playing the fold-toward-centre animation. Keyed by
  // seat.id, value is `{ displayPos, faceUp, cards }` — a snapshot taken at
  // trigger time so the overlay stays anchored to the original seat even if
  // the seat layout rotates mid-animation. The same map will be driven by
  // backend events later (one per player who folds).
  const [foldingSeats, setFoldingSeats] = useState<FoldingMap>({});
  // Свара state — populated when two or more seats share the top score at
  // showdown. `svaraSeatIds` keys are stringified seat.id (matches the
  // showdown `seatHands` keys). `myDecision` toggles between null /
  // 'join' / 'decline' for the local player. Cleared on every new deal.
  const [svaraSeatIds, setSvaraSeatIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [svaraDecision, setSvaraDecision] = useState<SvaraDecision | null>(null);
  // Two-stage Svara UI: the big centred SVARA title pulses 3-4 times on
  // the felt, then the banner swaps to a popup card with the join/decline
  // buttons. The phase is driven by a timer that fires once the banner
  // becomes visible (`svaraBannerVisible`).
  const [svaraPhase, setSvaraPhase] = useState<SvaraPhase>('announce');
  // Gates the SvaraBanner render so the on-table SVARA splash appears
  // ~1s AFTER the tie is detected (and the tied chips are already
  // blinking). Without this gate the splash would land on the felt the
  // same frame the cards finished flipping, which felt rushed.
  const [svaraBannerVisible, setSvaraBannerVisible] = useState<boolean>(false);

  // ── Winner state ────────────────────────────────────────────────
  const [winnerSeatId, setWinnerSeatId] = useState<string | null>(null);
  const [winnerAmount, setWinnerAmount] = useState<string | null>(null);
  // WinnerChipsOverlay is a controller: when this is non-null it sweeps the
  // actual on-table chips (the ones already rendered by AnteOverlay / BetOverlay)
  // onto the winner's seat. It renders no chips of its own, so all it needs
  // is the destination seat id.
  const [winnerChipFlight, setWinnerChipFlight] = useState<{
    seatId: string;
    // Number of chips swept onto the winner. Drives the bank counter's
    // tick-down duration so the counter hits 0 in lock-step with the
    // last chip landing, regardless of how many chips are on the felt.
    chipCount: number;
  } | null>(null);
  // Pending pot amount captured the moment the winner is selected. Cached
  // in a ref so the per-chip landing callback can read the final figure
  // without depending on the showdown effect's closure.
  const pendingPotRef = useRef<number>(0);

  // ── Ante animation ────────────────────────────────────────────────
  // Bumped every time `showDealing` flips true so AnteOverlay re-mounts under
  // a fresh key and replays the chip-toss for the new round. Stays at 0
  // (overlay hidden) until the first deal kicks in.
  const [anteRound, setAnteRound] = useState<number>(0);
  const prevShowDealingRef = useRef<boolean>(false);

  // True once the ante chip-toss has finished and the deck is allowed to
  // appear / start dealing. We deliberately split this from `showDealing` so
  // chips fly to the pot first, land, and only then the centre deck drops
  // in and the card-deal animation begins.
  const [cardsDealing, setCardsDealing] = useState<boolean>(false);
  const [betFlights, setBetFlights] = useState<BetFlight[]>([]);
  const betFlightIdRef = useRef<number>(0);
  const betPileSlotRef = useRef<number>(0);
  // Running count of chips currently sitting in the bank pile (ante + bets),
  // capped at MAX_VISIBLE_BET_PILE_SLOTS so we never animate more chips than
  // the player actually sees on the felt. Drives the winner sweep so every
  // visible chip is sent to the winner — not a fixed 6–14 batch.
  const bankChipCountRef = useRef<number>(0);

  // ── Turn timer state ──────────────────────────────────────────────
  // Which seat id (string) currently has the timer running.
  const [activeTurnSeatId, setActiveTurnSeatId] = useState<string | null>(null);
  // 0-1 progress: 1 = full time, 0 = expired.
  const [turnTimerProgress, setTurnTimerProgress] = useState<number>(1);
  const turnStartRef = useRef<number>(0);
  const turnRafRef = useRef<number>(0);
  // setTimeout backup for the auto-pass trigger. RAF is throttled inside
  // backgrounded Telegram WebViews (and some mobile browsers when the user
  // scrolls or switches apps), so we also schedule a hard setTimeout so the
  // fold fires on time regardless of whether the RAF loop is ticking.
  const turnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref tracking whether auto-pass has already fired for the current
  // turn cycle so neither the RAF loop nor the setTimeout backup call
  // handlePass twice.
  const autoPassedRef = useRef<boolean>(false);
  // True once the dealing animation has finished — controls when buttons appear.
  const [dealingDone, setDealingDone] = useState<boolean>(false);
  // True after the me-seat auto-folds (timeout pass) — hides dealt cards.
  const [myAutoFolded, setMyAutoFolded] = useState<boolean>(false);

  // Bag of pending one-shot timers spawned from callbacks (fold cleanup,
  // post-flight bar swap, card-open sound). They're cleared on unmount so a
  // late `setState` can't fire on a dead component.
  const timerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      timerRefs.current.forEach(clearTimeout);
      timerRefs.current = [];
      if (potCountdownRafRef.current != null) {
        cancelAnimationFrame(potCountdownRafRef.current);
        potCountdownRafRef.current = null;
      }
    },
    [],
  );

  // Smooth bank count-down driven by rAF whenever the winner chip flight
  // is active. Decoupled from the per-chip stagger so the readout always
  // ticks down evenly across the full flight window, regardless of how
  // many chips happen to be on the felt.
  useEffect(() => {
    if (!winnerChipFlight) return;
    const startPot =
      pendingPotRef.current > 0
        ? pendingPotRef.current
        : Math.max(localPotRef.current, 0);
    if (startPot <= 0) {
      setPotCountdown(0);
      return;
    }
    // Slight buffer past the per-chip flight so the counter lands on 0 a
    // hair after the last chip arrives — matches the "chips land, then
    // counter clicks to 0" beat in the reference. Total window matches
    // `chipFlightTotalMs` in the showdown effect (cluster spread + per
    // chip duration).
    const duration = 200 + 1800 + 220;
    const start = performance.now();
    setPotCountdown(startPot);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // Ease-out: chips burn off the counter quickly at the start, then
      // the last few units slide to 0 in lock-step with the trailing chips.
      const eased = 1 - Math.pow(1 - t, 1.4);
      const next = Math.max(0, Math.round(startPot * (1 - eased)));
      setPotCountdown(next);
      if (t < 1) {
        potCountdownRafRef.current = requestAnimationFrame(tick);
      } else {
        potCountdownRafRef.current = null;
      }
    };
    potCountdownRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (potCountdownRafRef.current != null) {
        cancelAnimationFrame(potCountdownRafRef.current);
        potCountdownRafRef.current = null;
      }
    };
  }, [winnerChipFlight]);

  // Warm the HTTP cache for every card PNG the moment the room mounts. The
  // "Открыть" reveal flips a card front-face into view over ~560ms; on a cold
  // cellular cache the <img> fetch can land mid-flip and produce a visible
  // glitch (blank / half-loaded card). Preloading sidesteps that entirely.
  useEffect(() => {
    preloadCardImages();
  }, []);

  // ── Turn timer tick (requestAnimationFrame) ─────────────────────
  // We keep handlePass in a ref so the RAF closure always calls the
  // latest version without re-creating the animation loop.
  const handlePassRef = useRef<(() => void) | null>(null);
  // Audio ref so the timer-start effect can play sounds without
  // depending on the `audio` value (defined later via useChatReactions).
  const audioRef = useRef<{ ensureCtx: () => AudioContext | null; soundRef: MutableRefObject<boolean> } | null>(null);
  // Tracks which turn we've already chimed for so React StrictMode's
  // double-invocation of effects in development can't fire the
  // turn-start chord twice for the same `activeTurnSeatId`.
  const lastTurnSoundIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeTurnSeatId) return;
    autoPassedRef.current = false;

    // Prefer the server's authoritative `turnStartTime`: the visible
    // clock then survives reconnects / WebView freezes — we render
    // "time elapsed since the server-recorded turn start", not "time
    // elapsed since this React effect re-ran". Fall back to
    // `performance.now()` only when no snapshot has landed yet (mock /
    // preview mode).
    const turnDurationMs =
      serverDriven && serverTurnDurationMs > 0
        ? serverTurnDurationMs
        : TURN_DURATION_MS;
    const serverStartWall =
      serverDriven && typeof serverTurnStartTime === 'number'
        ? serverTurnStartTime
        : null;
    const initialElapsed =
      serverStartWall !== null
        ? Math.max(0, Date.now() - serverStartWall)
        : 0;
    const initialRemainingMs = Math.max(0, turnDurationMs - initialElapsed);
    // `turnStartRef` is used by the RAF loop below — anchor it so
    // `performance.now() - turnStartRef` equals server-elapsed time
    // for the rest of the turn.
    turnStartRef.current = performance.now() - initialElapsed;
    setTurnTimerProgress(initialRemainingMs / turnDurationMs);

    // Sound + vibration on turn start. Guard with a ref so the chord only
    // plays once per turn even if the effect runs twice (StrictMode, or
    // synthetic re-renders that don't change `activeTurnSeatId`).
    if (lastTurnSoundIdRef.current !== activeTurnSeatId) {
      lastTurnSoundIdRef.current = activeTurnSeatId;
      hapticTap();
      if (audioRef.current?.soundRef.current) {
        const ctx = audioRef.current.ensureCtx();
        if (ctx) playTurnStartSound(ctx);
      }
    }

    const fireAutoPass = () => {
      if (autoPassedRef.current) return;
      autoPassedRef.current = true;
      handlePassRef.current?.();
    };

    const tick = () => {
      const elapsed = performance.now() - turnStartRef.current;
      const remaining = Math.max(0, 1 - elapsed / turnDurationMs);
      setTurnTimerProgress(remaining);

      if (remaining <= 0) {
        fireAutoPass();
        return;
      }
      turnRafRef.current = requestAnimationFrame(tick);
    };
    turnRafRef.current = requestAnimationFrame(tick);
    // Backup trigger: setTimeout fires on time even when RAF is throttled.
    // Uses the *remaining* budget so a reconnect mid-turn doesn't grant
    // the player a fresh 15s.
    turnTimeoutRef.current = setTimeout(fireAutoPass, initialRemainingMs);
    return () => {
      cancelAnimationFrame(turnRafRef.current);
      if (turnTimeoutRef.current != null) {
        clearTimeout(turnTimeoutRef.current);
        turnTimeoutRef.current = null;
      }
    };
  }, [activeTurnSeatId, serverDriven, serverTurnStartTime, serverTurnDurationMs]);

  // Start the turn timer for the me-seat once the dealing animation ends.
  // Driven by `cardsDealing` (post-ante) so the dealEnd math starts from the
  // moment cards begin flying — not from the moment chips start moving.
  useEffect(() => {
    if (!cardsDealing) {
      // Not dealing — clear any active timer.
      setActiveTurnSeatId(null);
      setDealingDone(false);
      setMyAutoFolded(false);
      return;
    }
    // Calculate the moment all cards have been dealt.
    const totalDeals = CARDS_PER_SEAT * activeDealOrder.length;
    const dealEndMs = (totalDeals - 1) * DEAL_STAGGER_MS + 720; // DEAL_DURATION_MS = 720

    const t = setTimeout(() => {
      setDealingDone(true);
      const me = seats.find((s) => s.me);
      if (me && me.id != null) {
        setActiveTurnSeatId(String(me.id));
      }
    }, dealEndMs + TURN_START_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardsDealing, activeDealOrder.length]);

  // Mirror the server-driven `activeSeatId` into the local turn timer.
  // The realtime slice exposes the seat by server position string
  // ("1".."6"); the UI's `activeTurnSeatId` is keyed by the local seat
  // id (1..6, matching `SEATS_DEFAULT[*].id`). Walk through
  // `SEATID_TO_POS` to find the anchor, then resolve the local seat
  // sitting there. The legacy `setActiveTurnSeatId(null|me)` paths
  // above still run for the mock / no-server flow — when
  // `serverDriven` is false this effect is a no-op.
  useEffect(() => {
    if (!serverDriven) return;
    if (serverActiveSeatId === null) {
      setActiveTurnSeatId(null);
      return;
    }
    const anchor = SEATID_TO_POS[String(serverActiveSeatId)];
    if (!anchor) {
      setActiveTurnSeatId(null);
      return;
    }
    const localSeat = seats.find((s) => s.pos === anchor);
    setActiveTurnSeatId(localSeat?.id != null ? String(localSeat.id) : null);
  }, [serverDriven, serverActiveSeatId, SEATID_TO_POS, seats]);

  // Server-driven mode: reconcile `dealingDone` with the wire phase.
  //
  // The svarapro backend transitions from `ante` through `blind_betting`
  // inside a single `publishGameUpdate` call — it processes the antes,
  // deals cards, then moves to the betting phase before persisting and
  // broadcasting. The client therefore never observes a stable
  // `phase === 'dealing'` window long enough for the local
  // `showDealing → cardsDealing → dealingDone` chain to complete, and
  // without this effect the Open/Blind buttons never appear.
  //
  // - `idle`            → between rounds, waiting for next deal. Reset.
  // - `dealing`         → let the local animation chain drive
  //                       `dealingDone`. If the server lingers in this
  //                       phase long enough for the chain to complete,
  //                       the chain wins; if it transitions away faster
  //                       than the animation, the `betting` branch
  //                       below promotes `dealingDone` to true.
  // - `betting`         → cards already dealt by the server. Force
  //                       `dealingDone` true and `myAutoFolded` false
  //                       so the action bar renders.
  // - `showdown` /
  //   `round_end`       → keep `dealingDone` true so the bar doesn't
  //                       blink to the empty placeholder mid-showdown.
  useEffect(() => {
    if (!serverDriven) return;
    if (serverPhase === 'idle') {
      setDealingDone(false);
      setMyAutoFolded(false);
      return;
    }
    if (serverPhase === 'dealing') {
      setMyAutoFolded(false);
      return;
    }
    // While the synthetic deal pulse is running, the chained
    // `cardsDealing` effect owns `dealingDone`. Forcing it true here
    // would race the animation and the action bar would flash in
    // mid-deal. Once the pulse drops the cardsDealing chain has
    // already settled `dealingDone = true` itself (or this effect
    // re-runs after the pulse ends and finishes the job).
    if (localDealingPulse) return;
    setDealingDone(true);
  }, [serverDriven, serverPhase, localDealingPulse]);

  // Bump `anteRound` on the rising edge of `showDealing` — AnteOverlay
  // re-mounts under the new key and replays the chip-toss for the new round.
  // While we're at it, schedule a poker-chip clink per landing chip. The
  // stagger matches AnteOverlay's per-chip delay (`ANTE_CHIP_STAGGER_MS`).
  //
  // Timing of the clink:
  //   - The chip flight uses cubic-bezier(0.45, 0.05, 0.25, 1), which is
  //     heavily front-loaded: numerically integrating the curve shows the
  //     chip covers ~90 % of its travel by t≈0.65 (~720 ms of an 1100 ms
  //     animation). The remaining 10 % is a soft deceleration tail. The
  //     *perceived* moment of impact lands near that 90 % mark, not at the
  //     literal 100 % keyframe.
  //   - We fire the clink ~40 ms before that perceived impact: human
  //     audio-visual sync feels best when audio leads video by 20-50 ms
  //     (in real life sound travels slower than light, our brain auto-
  //     compensates). Tying the offset to the animation constant keeps it
  //     honest if we ever retune the duration.
  // `ANTE_CHIP_DURATION_MS` is a module-level constant, so this expression
  // is a stable build-time value — pull it out of the render path entirely
  // and reference the constant directly from any hooks that need it. Keeps
  // the react-hooks/exhaustive-deps linter honest.
  const CHIP_SOUND_OFFSET_MS = useMemo(
    () => Math.round(ANTE_CHIP_DURATION_MS * 0.58) - 50,
    [],
  );
  useEffect(() => {
    const rising = showDealing && !prevShowDealingRef.current;
    const falling = !showDealing && prevShowDealingRef.current;
    prevShowDealingRef.current = showDealing;
    if (falling) {
      // Round ended — close the deal gate so the next round starts with the
      // ante toss only (no deck visible yet).
      setCardsDealing(false);
      return;
    }
    if (!rising) return;
    setAnteRound((r) => r + 1);
    setBetFlights([]);
    betPileSlotRef.current = 0;
    const occupied = seats.filter((s) => !s.empty && s.id != null).length;
    // Ante puts one chip per occupied seat into the bank pile; the bank
    // counter starts from there and grows with every subsequent bet flight.
    bankChipCountRef.current = Math.min(MAX_VISIBLE_BET_PILE_SLOTS, occupied);
    // Seed the local pot with this round's antes so the bank readout
    // matches the chips that just landed on the felt.
    localPotRef.current = occupied * ANTE_PER_SEAT_DEMO;
    setLocalPot(localPotRef.current);
    if (potCountdownRafRef.current != null) {
      cancelAnimationFrame(potCountdownRafRef.current);
      potCountdownRafRef.current = null;
    }
    setPotCountdown(null);
    // Hold the deck off-screen until every chip has landed, then open the
    // gate. With 0 occupied seats (edge case) skip the wait entirely.
    const anteTotalMs = getAnteTotalMs(occupied);
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(
      setTimeout(() => {
        setCardsDealing(true);
      }, anteTotalMs),
    );
    if (occupied === 0) {
      return () => {
        for (const t of timers) clearTimeout(t);
      };
    }
    for (let i = 0; i < occupied; i += 1) {
      timers.push(
        setTimeout(() => {
          const a = audioRef.current;
          if (!a?.soundRef.current) return;
          const ctx = a.ensureCtx();
          if (!ctx) return;
          try {
            playPokerChipSound(ctx, i);
          } catch {
            // ignore
          }
        }, CHIP_SOUND_OFFSET_MS + i * ANTE_CHIP_STAGGER_MS),
      );
    }
    return () => {
      for (const t of timers) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDealing]);

  // Re-deal fresh hands at the start of every dealing animation. Each seat
  // (including me) gets a hand assigned **up-front** so that when «Вскрыть
  // всех» fires later, the showdown reveals the same three cards that were
  // dealt out — not freshly generated ones. The backend can override this
  // via WS later (one ROUND_START message carrying every seat's hand).
  //
  // `seats` is intentionally NOT in the deps array: the effect fires when
  // `showDealing` flips to true, and the closure captures the seats from
  // that render. Late joins/leaves mid-deal do not re-trigger another
  // deck shuffle.
  useEffect(() => {
    if (!showDealing) return;
    const myDealt = dealHand();
    setMyHand(myDealt);
    const dealt: Record<string, Card[]> = {};
    for (const s of seats) {
      if (s.empty || s.id == null) continue;
      dealt[String(s.id)] = s.me ? myDealt : dealHand();
    }
    setSeatHands(dealt);
    setShowdown(false);
    setCardsOpened(false);
    setFoldingSeats({});
    setWinnerSeatId(null);
    setWinnerAmount(null);
    setWinnerChipFlight(null);
    // Reset the pot count-down so the next round's bank starts at the
    // freshly-seeded ante total rather than the previous winner's 0.
    if (potCountdownRafRef.current != null) {
      cancelAnimationFrame(potCountdownRafRef.current);
      potCountdownRafRef.current = null;
    }
    setPotCountdown(null);
    // Fresh deal — Svara state always resets so a stale tie from the
    // previous round can't bleed into the new one.
    setSvaraSeatIds(new Set<string>());
    setSvaraDecision(null);
    setSvaraPhase('announce');
    setSvaraBannerVisible(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDealing, room?.id]);

  // Generic fold trigger — works for any seat. Adds an entry to
  // `foldingSeats` and schedules its removal after the animation finishes.
  // Backend integration: call this from a WS handler with the folding
  // player's seat. `faceUp` controls whether to render the face-up fan (the
  // me-seat with cards open) or just card backs (everyone else).
  const triggerSeatFold = useCallback(
    ({ seat }: { seat: RotationSeat | null | undefined }) => {
      if (!seat || seat.id == null) return;
      const seatId = String(seat.id);
      const displayPos = getDisplayPos(seat.pos);
      // The overlay always renders a small face-down pile (no flip), so we
      // don't need to snapshot the open hand here — the visual is identical
      // whether the folding player had their cards open or not.
      setFoldingSeats((prev) => ({
        ...prev,
        [seatId]: { displayPos },
      }));
      timerRefs.current.push(
        setTimeout(() => {
          setFoldingSeats((prev) => {
            if (!(seatId in prev)) return prev;
            const next = { ...prev };
            delete next[seatId];
            return next;
          });
        }, HAND_FOLD_TOTAL_MS),
      );
    },
    [getDisplayPos],
  );

  const mySeat = seats.find((sx) => sx.me);
  const mySeatId: string | number | null = mySeat?.id ?? null;
  const mySeatKey: string | null = mySeatId == null ? null : String(mySeatId);

  // True when the server's `currentPlayerIndex` (translated through the
  // adapter and the rotation map into our local seat id) matches the
  // local player's seat. Used to gate the action bar so opponents
  // don't see Open / Blind / Pass / Call / Raise during their wait.
  //
  // Always `false` in mock mode (no server snapshot yet), but the
  // legacy local code path drives `activeTurnSeatId` directly via the
  // local dealing chain anyway — so the gate falls through naturally
  // once `setActiveTurnSeatId(String(me.id))` fires there.
  const isMyTurn =
    mySeatKey !== null && activeTurnSeatId !== null && activeTurnSeatId === mySeatKey;

  const triggerBetFlight = useCallback((amount: number) => {
    if (mySeatId == null) return;
    const id = betFlightIdRef.current + 1;
    betFlightIdRef.current = id;
    const chipCount = getBetChipCount(amount);
    const slotStart = betPileSlotRef.current;
    betPileSlotRef.current = (slotStart + chipCount) % MAX_VISIBLE_BET_PILE_SLOTS;
    bankChipCountRef.current = Math.min(
      MAX_VISIBLE_BET_PILE_SLOTS,
      bankChipCountRef.current + chipCount,
    );
    // Bet amount feeds the local pot so the bank counter updates as soon as
    // the chip flight kicks off. Wrapped in a same-tick state update so the
    // counter and the flying chips appear in the same frame.
    localPotRef.current += amount;
    setLocalPot(localPotRef.current);
    setBetFlights((prev) => [...prev, { id, seatId: String(mySeatId), chipCount, slotStart }]);
    for (let i = 0; i < chipCount; i += 1) {
      timerRefs.current.push(
        setTimeout(() => {
          const a = audioRef.current;
          if (!a?.soundRef.current) return;
          const ctx = a.ensureCtx();
          if (!ctx) return;
          try {
            playPokerChipSound(ctx, i);
          } catch {
            // ignore
          }
        }, CHIP_SOUND_OFFSET_MS + i * ANTE_CHIP_STAGGER_MS),
      );
    }
  }, [mySeatId, CHIP_SOUND_OFFSET_MS]);

  // The local player's server-side seat snapshot. Carries
  // `bet` (player.currentBet on the server), `stack`, `folded`, and
  // the betting flags (`hasLooked`, `hasLookedAndMustAct`) we use to
  // gate the action buttons. Falls back to `null` until the first
  // snapshot lands so mock / preview mode skips the server-driven
  // amount math entirely.
  const myServerSeat = useMemo(() => {
    if (!serverDriven || !myServerSeatId) return null;
    return realSeats?.[myServerSeatId] ?? null;
  }, [serverDriven, myServerSeatId, realSeats]);
  const myServerBet = myServerSeat?.bet ?? 0;
  const myServerStack = myServerSeat?.stack ?? 0;
  // Static-prop fallbacks for the call/raise amounts. These match the
  // pre-server-state behaviour and only run in mock / preview mode
  // (serverDriven === false) — once a snapshot lands we switch to the
  // server-derived values below.
  const fallbackCallAmount = Math.round(blindAmount / 2);
  const fallbackMinRaise = blindAmount;
  const fallbackMaxRaise = blindAmount * 10;
  // The amount the server expects for `call`:
  //   call = currentBet - player.currentBet
  // After a blind-phase `look`, the server enforces `lastBlindBet * 2`
  // as the call (see `betting.service.ts`), so we route through
  // `currentBet` which the server already keeps in sync with that rule.
  // Clamped at 0 so we don't ever ship a negative call amount.
  const callAmount = serverDriven
    ? Math.max(0, serverCurrentBet - myServerBet)
    : fallbackCallAmount;
  // Raise presets — min is `lastActionAmount * 2` (or `currentBet * 2`
  // when no action has happened yet), max is the player's full stack
  // so "Max" really means all-in.
  const minRaiseAmount = serverDriven
    ? Math.max(serverLastActionAmount, serverCurrentBet, serverMinBet) * 2 ||
      serverMinBet * 2
    : fallbackMinRaise;
  const maxRaiseAmount = serverDriven
    ? Math.max(myServerStack, minRaiseAmount)
    : fallbackMaxRaise;
  const raiseCurrentBet = serverDriven
    ? Math.max(serverLastActionAmount, serverCurrentBet)
    : fallbackCallAmount;
  // Amount for a blind_bet action. The first blind-bettor pays the
  // table `minBet` (== ante == `blindAmount`); every subsequent blind
  // bettor must double the previous one (`lastBlindBet * 2`).
  const blindBetAmount = serverDriven
    ? serverLastBlindBet > 0
      ? serverLastBlindBet * 2
      : serverMinBet || blindAmount
    : blindAmount;

  const handleBlindBet = useCallback(() => {
    hapticTap();
    triggerBetFlight(blindBetAmount);
    if (room?.id !== undefined) {
      sendGameAction(String(room.id), 'blind_bet', blindBetAmount);
    }
  }, [room?.id, blindBetAmount, triggerBetFlight]);

  const handleCall = useCallback(() => {
    hapticTap();
    triggerBetFlight(callAmount);
    if (room?.id !== undefined) {
      sendGameAction(String(room.id), 'call', callAmount);
    }
  }, [room?.id, callAmount, triggerBetFlight]);

  const handleRaise = useCallback(() => {
    hapticTap();
    setRaiseOpen(true);
  }, []);

  const handleRaiseConfirm = useCallback(
    (amount: number) => {
      setRaiseOpen(false);
      triggerBetFlight(amount);
      if (room?.id !== undefined) {
        sendGameAction(String(room.id), 'raise', amount);
      }
    },
    [room?.id, triggerBetFlight],
  );

  const handlePass = useCallback(() => {
    hapticTap();
    // Stop the turn timer (both RAF and the setTimeout backup).
    setActiveTurnSeatId(null);
    cancelAnimationFrame(turnRafRef.current);
    if (turnTimeoutRef.current != null) {
      clearTimeout(turnTimeoutRef.current);
      turnTimeoutRef.current = null;
    }
    setMyAutoFolded(true);
    if (room?.id !== undefined) {
      sendGameAction(String(room.id), 'fold');
    }
    if (!mySeat) {
      setCardsOpened(false);
      return;
    }
    triggerSeatFold({ seat: mySeat });
    timerRefs.current.push(
      setTimeout(() => {
        setCardsOpened(false);
      }, HAND_FOLD_FLIGHT_MS),
    );
  }, [room?.id, mySeat, triggerSeatFold]);

  // Keep the handlePass ref in sync for the RAF auto-pass.
  useEffect(() => {
    handlePassRef.current = handlePass;
  }, [handlePass]);

  const { reactions, showReaction, audio } = useChatReactions(settings.sound);
  audioRef.current = audio;

  // Per-local-seat hand pinned by the server. Each `realSeats` entry is
  // keyed by the server position ("1".. "6"); we walk the rotated
  // `SEATID_TO_POS` map to find the matching display anchor and resolve
  // the local seat sitting at that anchor. The result is a
  // `Record<localSeatId, Card[]>` that handleShowdown / the dealing
  // effect can prefer over the mock `dealHand()` output.
  const serverHandsBySeatId = useMemo<Record<string, Card[]>>(() => {
    if (!serverDriven) return {};
    const map: Record<string, Card[]> = {};
    for (const [serverPosId, serverSeat] of Object.entries(realSeats ?? {})) {
      if (!serverSeat.hand || serverSeat.hand.length === 0) continue;
      const anchor = SEATID_TO_POS[serverPosId];
      if (!anchor) continue;
      const localSeat = seats.find((s) => s.pos === anchor);
      if (localSeat?.id == null) continue;
      map[String(localSeat.id)] = serverSeat.hand as Card[];
    }
    return map;
  }, [serverDriven, realSeats, SEATID_TO_POS, seats]);

  // The local player's hand as pushed by the server (only present for the
  // receiving player's own seat — svarapro's protocol intentionally omits
  // other players' cards until showdown).
  const serverMyHand = useMemo<Card[] | null>(() => {
    if (!serverDriven || !myServerSeatId) return null;
    const serverSeat = realSeats?.[myServerSeatId];
    if (!serverSeat?.hand || serverSeat.hand.length === 0) return null;
    return serverSeat.hand as Card[];
  }, [serverDriven, myServerSeatId, realSeats]);

  // Overlay the server hand on top of the locally-dealt placeholder as
  // soon as the wire ships it. The placeholder set by the deal-effect
  // keeps the open-hand fan looking right during the dealing animation
  // (before the server-side `cards` field is populated for our seat);
  // once the real hand arrives, this swaps it in without re-triggering
  // any animation — `myHand` only feeds the post-open render path.
  useEffect(() => {
    if (!serverMyHand) return;
    setMyHand(serverMyHand);
  }, [serverMyHand]);

  // Reconcile local UI state with the server's authoritative
  // `hasLooked` / `folded` for the local seat. This is what makes a
  // reconnect mid-round restore the correct action bar:
  //   - if the server says I've already looked, jump straight to
  //     PostOpenButtons (no second optimistic "look" send);
  //   - if the server says I've folded, suppress the action bar via
  //     `myAutoFolded`.
  // We never *unset* `cardsOpened` from this effect (going from
  // "looked" back to "blind" mid-round is not a legal server
  // transition — only `resetRealtime` on room exit clears it).
  useEffect(() => {
    if (!myServerSeat) return;
    if (myServerSeat.hasLooked && !cardsOpened) {
      setCardsOpened(true);
    }
    if (myServerSeat.folded && !myAutoFolded) {
      setMyAutoFolded(true);
    }
  }, [myServerSeat, cardsOpened, myAutoFolded]);

  // Showdown — flip every seat's cards face-up simultaneously. When the
  // server is driving the round, prefer per-seat `hand` arrays from the
  // realtime slice (populated by `svaraAdapter.adaptPlayerToSeat` when
  // `status === 'showdown'` flips the reveal flag for everyone). Falls
  // back to the locally-dealt placeholder from the deal-effect, or a
  // fresh `dealHand()` for late joiners, so the demo / no-server flow
  // keeps working.
  const handleShowdown = useCallback(() => {
    hapticTap();
    setMenuOpen(false);
    setSeatHands((prev) => {
      const next: Record<string, Card[]> = { ...prev };
      for (const s of seats) {
        if (s.empty || s.id == null) continue;
        const key = String(s.id);
        // Server hand always wins — it's the authoritative reveal data.
        if (serverHandsBySeatId[key]) {
          next[key] = serverHandsBySeatId[key];
          continue;
        }
        if (next[key]) continue;
        next[key] = s.me ? myHand : dealHand();
      }
      return next;
    });
    setShowdown(true);
    setCardsOpened(true);
    // One reveal sound, timed so it lands together with the flip animation
    // (HAND_ENTER_DURATION_MS is the entry delay before the flip kicks in).
    timerRefs.current.push(
      setTimeout(() => {
        if (!audio.soundRef.current) return;
        const ctx = audio.ensureCtx();
        if (!ctx) return;
        try {
          playCardOpenSound(ctx);
        } catch {}
      }, HAND_ENTER_DURATION_MS),
    );
  }, [seats, myHand, audio, serverHandsBySeatId]);

  // Auto-fire the showdown when the server transitions into the showdown
  // phase (svarapro `status === 'showdown' | 'finished' | 'svara' |
  // 'svara_pending'` — all of which the adapter maps to `'showdown'`).
  // Without this, the action bar would stay in betting mode forever and
  // the only way to flip cards face-up would be the dev menu's «Vskryt'
  // vsekh (demo)» entry.
  useEffect(() => {
    if (!serverDriven) return;
    if (serverPhase !== 'showdown') return;
    if (showdown) return;
    handleShowdown();
  }, [serverDriven, serverPhase, showdown, handleShowdown]);

  // Svara demo — force a tie at showdown. Picks the first 2-3 occupied
  // seats (preferring the me-seat so the local player gets the join/decline
  // buttons) and gives them the same easy-to-tie 3-card hand. The
  // remaining seats keep a random hand so the tied seats stand out clearly.
  // Will go away once the backend ROUND_RESULT carries real per-seat hands.
  const handleSvaraDemo = useCallback(() => {
    hapticTap();
    setMenuOpen(false);
    // High-suit 31-of-spades hand: A♠+K♠+10♠ scores 11+10+10 = 31. We use
    // an identical hand for every tied seat so duplicate cards don't matter
    // (the same caveat applies to the existing showdown demo).
    const tiedHand: Card[] = [
      { rank: 'A', suit: 'spade' },
      { rank: 'K', suit: 'spade' },
      { rank: '10', suit: 'spade' },
    ];
    const occupied = seats.filter((s) => !s.empty && s.id != null);
    if (occupied.length < 2) return;
    // Prefer the me-seat first so the local player sees the join/decline
    // buttons; then fill up to three tied seats from the rest.
    const ordered = [
      ...occupied.filter((s) => s.me),
      ...occupied.filter((s) => !s.me),
    ];
    const tieCount = Math.min(3, ordered.length);
    const tiedKeys = new Set<string>();
    const dealt: Record<string, Card[]> = {};
    for (let i = 0; i < ordered.length; i += 1) {
      const s = ordered[i];
      if (s.id == null) continue;
      const key = String(s.id);
      if (i < tieCount) {
        dealt[key] = tiedHand;
        tiedKeys.add(key);
      } else {
        // Non-tied seats get a fresh random hand; on the rare chance it
        // also scores 31 of spades the visual still reads correctly (they
        // would just have ended up in the tie anyway).
        dealt[key] = dealHand();
      }
    }
    // Keep `myHand` in sync if the me-seat is part of the tie so the
    // post-open card art matches the showdown reveal exactly.
    const meKey = mySeatKey;
    if (meKey && dealt[meKey]) {
      setMyHand(dealt[meKey]);
    }
    setSeatHands(dealt);
    setShowdown(true);
    setCardsOpened(true);
    // Pin tied seats immediately so their score-chips/badges paint as
    // gold (and start the blink) the moment they animate in. The on-table
    // SVARA splash itself is held back via `svaraBannerVisible` so the
    // player still gets a beat with the cards before the title appears.
    setSvaraSeatIds(tiedKeys);
    setSvaraDecision(null);
    setSvaraPhase('announce');
    setSvaraBannerVisible(false);
    timerRefs.current.push(
      setTimeout(() => {
        if (!audio.soundRef.current) return;
        const ctx = audio.ensureCtx();
        if (!ctx) return;
        try {
          playCardOpenSound(ctx);
        } catch {}
      }, HAND_ENTER_DURATION_MS),
    );
  }, [seats, mySeatKey, audio]);

  // Auto-detect Свара after a normal showdown. Walks every revealed hand,
  // finds the top score, and — if two or more seats share that top score —
  // pins them as Svara participants right away. Score-chips/badges read
  // the tie via `svaraSeatIds`, so writing it on the same commit as the
  // reveal makes them paint gold + blink from the first animation frame.
  // The big SVARA splash on the felt is delayed separately via
  // `svaraBannerVisible` below. Skips work when the showdown demo already
  // set `svaraSeatIds` (Svara demo) or no showdown is in flight.
  useEffect(() => {
    if (!showdown) return;
    if (svaraSeatIds.size > 0) return;
    const scored: Array<{ key: string; score: number }> = [];
    for (const [key, hand] of Object.entries(seatHands)) {
      if (!hand || hand.length === 0) continue;
      scored.push({ key, score: svaraHandScore(hand) });
    }
    if (scored.length < 2) return;
    const top = scored.reduce((m, s) => (s.score > m ? s.score : m), 0);
    const tied = scored.filter((s) => s.score === top).map((s) => s.key);
    if (tied.length < 2) return;
    setSvaraSeatIds(new Set(tied));
    setSvaraDecision(null);
    setSvaraPhase('announce');
    setSvaraBannerVisible(false);
  }, [showdown, seatHands, svaraSeatIds.size]);

  // Detect the winner after showdown: the single highest scorer.
  // Skipped when a Svara tie is detected (tied seats get the Svara flow).
  //
  // Server-driven mode resolves the winner from `state.winners[0]` in
  // the snapshot (forwarded through the adapter as `winnerId`); fall
  // back to the local `svaraHandScore` only for the mock / no-server
  // demo paths. The local score function only handles three-of-a-rank
  // and the suit-sum case — it disagrees with `card.service.calculateScore`
  // on three 7s (34), two 7s (23), two aces (22), and the joker 7♣
  // substitution, so trusting it against a real backend would award
  // the wrong seat the chips.
  useEffect(() => {
    if (!showdown) return;
    if (svaraSeatIds.size > 0) return;

    let winnerId: string | null = null;
    if (serverDriven) {
      if (serverWinnerSeatId === null || serverWinnerSeatId === undefined) {
        return;
      }
      const anchor = SEATID_TO_POS[String(serverWinnerSeatId)];
      if (!anchor) return;
      const localSeat = seats.find((s) => s.pos === anchor);
      if (localSeat?.id == null) return;
      winnerId = String(localSeat.id);
    } else {
      const scored: Array<{ key: string; score: number }> = [];
      for (const [key, hand] of Object.entries(seatHands)) {
        if (!hand || hand.length === 0) continue;
        scored.push({ key, score: svaraHandScore(hand) });
      }
      if (scored.length < 2) return;
      const top = scored.reduce((m, s) => (s.score > m ? s.score : m), 0);
      const winners = scored.filter((s) => s.score === top);
      if (winners.length !== 1) return;
      winnerId = winners[0].key;
    }
    if (winnerId === null) return;
    // Calculate pot. Prefer the local running tally (antes + bets booked
    // through `triggerBetFlight`) so the win badge matches the bank
    // readout that the player just watched tick down to 0. Falls back to a
    // bare per-seat mock when nothing has been booked locally.
    const pot =
      localPotRef.current > 0
        ? localPotRef.current
        : seats.filter((s) => !s.empty).length * ANTE_PER_SEAT_DEMO;
    pendingPotRef.current = pot;
    // Drives both the chip-clink cascade sound and the total flight
    // window. `WinnerChipsOverlay` staggers each chip by
    // `ANTE_CHIP_STAGGER_MS` (same as a bet flight), so the on-screen
    // sweep finishes ~(chipCount - 1) * stagger after the first chip
    // leaves.
    const chipCount = Math.min(
      MAX_VISIBLE_BET_PILE_SLOTS,
      Math.max(1, bankChipCountRef.current),
    );
    // Sequence: cards open → 800ms → winner gets crown + score blinks →
    // 1000ms pause → the chips on the table sweep onto the winner in a
    // staggered stream, with the bank counter ticking down to 0 as each
    // chip lands → once the last chip arrives, the win amount pops in
    // above the winner's nameplate.
    const WINNER_TO_CHIPS_PAUSE_MS = 1000;
    // Per-chip flight for the winner sweep is intentionally slower than
    // the bet flight (see WINNER_CHIP_DURATION_MS in
    // WinnerChipsOverlay.tsx). Total flight window = cluster spread
    // (~200 ms) + one per-chip flight.
    const WINNER_CHIP_DURATION_MS = 1800;
    const WINNER_CLUSTER_SPREAD_MS = 200;
    const chipFlightTotalMs =
      WINNER_CLUSTER_SPREAD_MS + WINNER_CHIP_DURATION_MS;
    const id = setTimeout(() => {
      setWinnerSeatId(winnerId);
      if (audioRef.current?.soundRef.current) {
        const ctx = audioRef.current.ensureCtx();
        if (ctx) playWinnerSound(ctx);
      }
      timerRefs.current.push(
        setTimeout(() => {
          setWinnerChipFlight({ seatId: winnerId, chipCount });
          // Restored to the pre-v137 behavior: one clink per visible
          // chip, with the stagger spread evenly across the whole
          // flight window so each clink lands roughly with its chip.
          // Capped at `ANTE_CHIP_STAGGER_MS` so very small chip
          // counts don't speed up to a single rattle, and offset
          // anchored to the ante's `CHIP_SOUND_OFFSET_MS` so the
          // cascade kicks in at the same relative point in the
          // flight as the ante chip-toss audio.
          const winnerSoundStaggerMs =
            chipCount > 1
              ? Math.min(
                  ANTE_CHIP_STAGGER_MS,
                  Math.floor((chipFlightTotalMs - 300) / (chipCount - 1)),
                )
              : 0;
          for (let i = 0; i < chipCount; i += 1) {
            timerRefs.current.push(
              setTimeout(() => {
                const a = audioRef.current;
                if (!a?.soundRef.current) return;
                const ctx = a.ensureCtx();
                if (!ctx) return;
                try {
                  playPokerChipSound(ctx, i);
                } catch {
                  // ignore
                }
              }, CHIP_SOUND_OFFSET_MS + i * winnerSoundStaggerMs),
            );
          }
          // Retire the overlay and pop the win badge a beat after the
          // last chip lands. The buffer matches the rAF countdown's
          // `duration` so the counter hits 0 in the same frame the badge
          // appears.
          timerRefs.current.push(
            setTimeout(() => {
              setWinnerChipFlight(null);
              setWinnerAmount(`+$${pendingPotRef.current}`);
            }, chipFlightTotalMs + 260),
          );
        }, WINNER_TO_CHIPS_PAUSE_MS),
      );
    }, 800);
    return () => clearTimeout(id);
  }, [
    showdown,
    seatHands,
    svaraSeatIds.size,
    seats,
    CHIP_SOUND_OFFSET_MS,
    serverDriven,
    serverWinnerSeatId,
    SEATID_TO_POS,
  ]);

  // Reveal the on-table SVARA splash ~1s after a tie is locked in so the
  // player has a beat to read everyone's cards (and notice the tied chips
  // already pulsing) before the title takes over the felt.
  useEffect(() => {
    if (svaraSeatIds.size < 2) return;
    if (svaraBannerVisible) return;
    const id = setTimeout(() => {
      setSvaraBannerVisible(true);
      if (audioRef.current?.soundRef.current) {
        const ctx = audioRef.current.ensureCtx();
        if (ctx) {
          try {
            playSvaraAnnounceSound(ctx);
          } catch {
            // ignore
          }
        }
      }
    }, SVARA_REVEAL_DELAY_MS);
    return () => clearTimeout(id);
  }, [svaraSeatIds, svaraBannerVisible]);

  // Flip the banner from announce → choose once the centred SVARA title
  // has finished its 3 blinks (~3.4s, matching the CSS animation duration
  // in SvaraBanner.module.css). Driven off `svaraBannerVisible` so the
  // 3.4s announce window is measured from the moment the splash actually
  // appears on the felt, not from when the tie was first detected.
  useEffect(() => {
    if (!svaraBannerVisible) return;
    if (svaraPhase !== 'announce') return;
    const id = setTimeout(() => setSvaraPhase('choose'), 3400);
    return () => clearTimeout(id);
  }, [svaraBannerVisible, svaraPhase]);

  const handleSvaraJoin = useCallback(() => {
    hapticTap();
    triggerBetFlight(blindAmount);
    setSvaraDecision('join');
    // Tell the server. Action only takes effect while the room is in
    // `svara_pending` (see `game.service.ts:468-471`) — other phases
    // produce a `'Недопустимое действие'` toast. The popup is gated
    // on `svaraActive` so by the time the user can press the button
    // the server is already in `svara_pending`.
    if (room?.id !== undefined) {
      sendGameAction(String(room.id), 'join_svara');
    }
  }, [blindAmount, triggerBetFlight, room?.id]);

  const handleSvaraDecline = useCallback(() => {
    hapticTap();
    setSvaraDecision('decline');
    if (room?.id !== undefined) {
      sendGameAction(String(room.id), 'skip_svara');
    }
  }, [room?.id]);

  const svaraActive = svaraSeatIds.size >= 2;
  const meInSvara = !!(mySeatKey && svaraSeatIds.has(mySeatKey));

  const handleOpenCards = useCallback(() => {
    // Idempotent against a rapid double-tap. Without this guard a fast double-
    // tap (touch latency on Android can be 50-100ms, well under one React
    // commit) would fire the reveal sound twice and re-schedule the entry
    // animation, producing an audible/visual glitch even though the bottom
    // bar has already swapped to PostOpenButtons.
    if (cardsOpened) return;
    hapticTap();
    setCardsOpened(true);
    timerRefs.current.push(
      setTimeout(() => {
        if (!audio.soundRef.current) return;
        const ctx = audio.ensureCtx();
        if (!ctx) return;
        try {
          playCardOpenSound(ctx);
        } catch {}
      }, HAND_ENTER_DURATION_MS),
    );
    if (room?.id !== undefined) {
      sendGameAction(String(room.id), 'look');
    }
  }, [audio, room?.id, cardsOpened]);

  // Map server `telegramId` → local seat id (1..6). Maintained from the
  // raw `SvaraGameState` snapshots so incoming chat reactions can be
  // attached to the correct seat without going through the adapter.
  const playerToSeatIdRef = useRef<Map<string, number>>(new Map());
  // Server-driven svara state. The `svaraSeatIds` set elsewhere in
  // this file is computed locally from `seatHands` (mock / showdown
  // tie detection); against a real server the tie is announced by
  // the gateway via `status === 'svara_pending'` together with
  // `winners[]` and `svaraConfirmed[]`. This hook mirrors those
  // fields so the SvaraBanner can:
  //   1. open even when the local hand-comparison path didn't fire,
  //   2. hide the join button when the local user already pressed
  //      Join (server's `svaraConfirmed` is the source of truth).
  const [serverSvaraSeatIds, setServerSvaraSeatIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [serverSvaraConfirmed, setServerSvaraConfirmed] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  useEffect(() => {
    const unsubscribe = subscribeToGameState((state) => {
      const next = new Map<string, number>();
      for (const player of state.players ?? []) {
        if (typeof player.position !== 'number') continue;
        const anchor = SEATID_TO_POS[String(player.position)];
        if (!anchor) continue;
        const localSeat = SEATS_DEFAULT.find((s) => s.pos === anchor);
        if (!localSeat) continue;
        next.set(String(player.id), localSeat.id);
      }
      playerToSeatIdRef.current = next;

      // Svara state mirroring. Outside `svara_pending` the banner
      // should be hidden, so clear both sets.
      if (state.status !== 'svara_pending') {
        setServerSvaraSeatIds((prev) => (prev.size === 0 ? prev : new Set()));
        setServerSvaraConfirmed((prev) => (prev.size === 0 ? prev : new Set()));
        return;
      }
      const tiedKeys = new Set<string>();
      for (const winner of state.winners ?? []) {
        if (typeof winner.position !== 'number') continue;
        const anchor = SEATID_TO_POS[String(winner.position)];
        if (!anchor) continue;
        const localSeat = SEATS_DEFAULT.find((s) => s.pos === anchor);
        if (!localSeat) continue;
        tiedKeys.add(String(localSeat.id));
      }
      setServerSvaraSeatIds(tiedKeys);
      setServerSvaraConfirmed(new Set(state.svaraConfirmed ?? []));
    });
    return unsubscribe;
  }, [SEATID_TO_POS]);

  // Promote the server-driven svara tie into `svaraSeatIds` so the
  // existing SvaraBanner machinery (announce → choose phases, popup
  // visibility, etc.) lights up without a real local hand-comparison.
  // Local mock mode still drives `svaraSeatIds` from `seatHands`, so
  // we only override when the server reported a tie.
  useEffect(() => {
    if (serverSvaraSeatIds.size < 2) return;
    setSvaraSeatIds(serverSvaraSeatIds);
    setSvaraDecision(null);
    setSvaraPhase('announce');
    setSvaraBannerVisible(true);
  }, [serverSvaraSeatIds]);

  // True once the server has confirmed our `join_svara` press. Mirror
  // the server's truth into the local `svaraDecision` so the popup
  // dismisses itself (the existing SvaraBanner hides as soon as
  // `myDecision !== null`). Prevents double-press in the window
  // between our `sendGameAction` and the next inbound snapshot.
  const myAlreadyConfirmedSvara =
    selfTelegramId !== null && serverSvaraConfirmed.has(selfTelegramId);
  useEffect(() => {
    if (!myAlreadyConfirmedSvara) return;
    setSvaraDecision((prev) => prev ?? 'join');
  }, [myAlreadyConfirmedSvara]);

  const handleChatPick = useCallback(
    (item: ChatPickItem) => {
      showReaction(mySeatId, item);
      if (room?.id !== undefined) {
        sendChatMessage(String(room.id), item.value);
      }
    },
    [mySeatId, room?.id, showReaction],
  );

  // Render reactions from other players. The server broadcasts each chat
  // message to the room (including the sender), so we filter out the local
  // user to avoid double-firing the bubble that `handleChatPick` already
  // showed locally.
  useEffect(() => {
    const unsubscribe = subscribeToChat(({ playerId, phrase }) => {
      if (!playerId || !phrase) return;
      const seatId = playerToSeatIdRef.current.get(String(playerId));
      if (seatId == null) return;
      if (seatId === mySeatId) return;
      const isEmoji = Array.from(phrase).length <= 2 && /\p{Extended_Pictographic}/u.test(phrase);
      const item: ChatPickItem = isEmoji
        ? { kind: 'emoji', emojiId: phrase, value: phrase }
        : { kind: 'text', value: phrase };
      showReaction(seatId, item);
    });
    return unsubscribe;
  }, [mySeatId, showReaction]);

  const handleSetThemePref = useCallback(
    (next: ThemePref) => {
      if (next !== 'dark' && next !== 'light' && next !== 'system') return;
      if (typeof onSetThemePref === 'function') onSetThemePref(next);
    },
    [onSetThemePref],
  );

  const inviteFriend = useCallback(() => {
    hapticTap();
    const roomKey = room?.id ?? room?.code ?? '';
    const displayNumber = room?.num ?? roomKey;
    const url = roomKey
      ? `https://t.me/MySvaraBot?startapp=room_${roomKey}`
      : 'https://t.me/MySvaraBot';
    const text = displayNumber
      ? `Я играю в Svara, комната #${displayNumber}. Заходи!`
      : 'Присоединяйся к Svara — играй в Свару прямо в Telegram';
    shareToTelegram({ url, text });
  }, [room?.id, room?.code, room?.num]);

  // Schedule one card-flick sound per dealt card, aligned to the deal timeline.
  // Driven by `cardsDealing` so the flicks start when the actual card-fly
  // animation starts (post-ante), not during the chip toss.
  useEffect(() => {
    if (!cardsDealing) return undefined;
    const totalDeals = CARDS_PER_SEAT * activeDealOrder.length;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < totalDeals; i++) {
      const flickTimer = setTimeout(() => {
        if (!audio.soundRef.current) return;
        const ctx = audio.ensureCtx();
        if (!ctx) return;
        try {
          playCardFlickSound(ctx, i);
        } catch {}
      }, i * DEAL_STAGGER_MS);
      timers.push(flickTimer);
    }
    return () => timers.forEach(clearTimeout);
  }, [activeDealOrder.length, cardsDealing, audio]);

  useTgBackButton(onExit);
  useBodyScrollLock();

  const waitingLabel = aloneInRoom
    ? 'Ждём игроков'
    : joinedMidDeal || waitForNextRound
      ? 'Ждём следующий раунд'
      : null;

  return (
    <div className={styles.root} style={{ background: t.bg, color: t.text }}>
      {/* Velvet noise texture overlay (subtle grain so the eyes don't strain) */}
      <div
        aria-hidden
        className={styles.noise}
        style={{ opacity: t.noiseOpacity, mixBlendMode: t.noiseBlend }}
      />
      {/* Soft vignette for depth (velvet feel) */}
      <div aria-hidden className={styles.vignette} style={{ background: t.vignette }} />
      <div className={styles.viewport}>
        <Header
          roomNum={room.num}
          onMenu={() => setMenuOpen(true)}
          theme={theme}
          t={t}
          topPadding={headerTopPadding}
          sidePadding={8}
        />

        <GameMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          theme={theme}
          themePref={themePref}
          onSetThemePref={handleSetThemePref}
          feltPreset={settings.feltPreset}
          onSetFeltPreset={settings.setFeltPreset}
          sound={settings.sound}
          onToggleSound={settings.toggleSound}
          vibration={settings.vibration}
          onToggleVibration={settings.toggleVibration}

          onShowdown={spectator ? undefined : handleShowdown}
          onSvaraDemo={spectator ? undefined : handleSvaraDemo}
          onExit={() => {
            setMenuOpen(false);
            setConfirmExit(true);
          }}
          t={t}
        />

        <ConfirmExit
          open={confirmExit}
          onCancel={() => setConfirmExit(false)}
          onConfirm={() => {
            setConfirmExit(false);
            onExit();
          }}
          theme={theme}
          t={t}
        />

        {/* Felt zone — pill table.
            On Android the available area is shorter than the table's
            maxHeight, so the table fills 100% of the available height.
            We trade ~20px of top padding for bottom padding so the whole
            table (and the absolutely-positioned seats inside it) shifts
            upward without changing the overall table height. iOS layout
            is unchanged. */}
        <div
          className={`${styles.feltZone} ${isAndroidTelegram ? styles.feltZoneAndroid : ''}`}
        >
          <div
            className={styles.tableHolder}
            style={{
              maxHeight: isAndroidTelegram ? TABLE_MAX_HEIGHT.android : TABLE_MAX_HEIGHT.default,
            }}
          >
            <Table
              feltInner={settings.felt.feltInner}
              feltOuter={settings.felt.feltOuter}
              dim={showdown}
            />
            <PotView amount={displayedPot} rakePercent={rakePercent} waitingLabel={waitingLabel} />

            {anteRound > 0 && (
              <AnteOverlay
                key={anteRound}
                seats={seats}
              />
            )}

            {cardsDealing && activeDealOrder.length > 0 && (
              <CenterDeck totalDeals={CARDS_PER_SEAT * activeDealOrder.length} />
            )}

            {betFlights.map((flight) => (
              <BetOverlay
                key={flight.id}
                seatId={flight.seatId}
                chipCount={flight.chipCount}
                slotStart={flight.slotStart}
                slotModulo={MAX_VISIBLE_BET_PILE_SLOTS}
              />
            ))}

            {winnerChipFlight && (
              <WinnerChipsOverlay seatId={winnerChipFlight.seatId} />
            )}

            <SeatsLayer
              seats={seats as SeatsLayerSeat[]}
              getDisplayPos={getDisplayPos}
              reactions={reactions}
              dealing={cardsDealing}
              spectator={spectator}
              onInvite={inviteFriend}
              onTakeSeat={handleTakeSeat}
              activeDealOrder={activeDealOrder}
              hideInviteArrow={joinedMidDeal}
              isJoinedMidDeal={joinedMidDeal}
              myHand={
                cardsOpened && mySeatKey && !foldingSeats[mySeatKey] ? myHand : undefined
              }
              seatHands={showdown ? seatHands : undefined}
              svaraSeatIds={svaraActive ? svaraSeatIds : undefined}
              activeTurnSeatId={activeTurnSeatId}
              turnTimerProgress={turnTimerProgress}
              myAutoFolded={myAutoFolded}
              winnerSeatId={winnerSeatId}
              winnerAmount={winnerAmount}
            />

            {Object.entries(foldingSeats).map(([seatId, entry]) => (
              <FoldingSeatOverlay key={seatId} displayPos={entry.displayPos} />
            ))}

            {svaraActive && svaraBannerVisible && (
              <SvaraBanner
                phase={svaraPhase}
                myDecision={svaraDecision}
                canDecide={meInSvara && !spectator}
                joinCost={blindAmount}
                onJoin={handleSvaraJoin}
                onDecline={handleSvaraDecline}
              />
            )}
          </div>
        </div>

        <GameRoomKeyframes />

        {!spectator && (
          <ChatButton
            onClick={() => setChatOpen((v) => !v)}
            bottom={CHAT_BUTTON_BOTTOM}
            theme={theme}
            variant={chatVariant}
          />
        )}

        {!spectator && (
          <ChatPanel
            open={chatOpen}
            onClose={() => setChatOpen(false)}
            onPick={handleChatPick}
            t={t}
          />
        )}

        {spectator ? (
          <SpectatorBar />
        ) : cardsOpened && isMyTurn ? (
          <PostOpenButtons
            callAmount={callAmount}
            onPass={handlePass}
            onCall={handleCall}
            onRaise={handleRaise}
          />
        ) : dealingDone && !myAutoFolded && isMyTurn ? (
          <ActionButtons
            blindAmount={blindAmount}
            onOpen={handleOpenCards}
            onBlind={handleBlindBet}
          />
        ) : (
          <div style={{ height: 72, flexShrink: 0 }} />
        )}

        <RaiseSheet
          open={raiseOpen}
          currentBet={raiseCurrentBet}
          minRaise={minRaiseAmount}
          maxRaise={maxRaiseAmount}
          onClose={() => setRaiseOpen(false)}
          onConfirm={handleRaiseConfirm}
        />
      </div>
    </div>
  );
}

// Keep TABLE_PRESETS export shape stable for any external consumers.
export { TABLE_PRESETS };
