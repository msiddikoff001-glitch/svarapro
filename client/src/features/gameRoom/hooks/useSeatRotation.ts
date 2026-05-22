import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DEAL_ORDER,
  DEAL_START_DELAY_MS,
  LAYOUT_DEAL_ORDER,
  LAYOUT_SEAT_MAP,
  ROUND_END_MS,
  SEAT_ROTATE_MS,
  type SeatAnchorPos,
  SEATS_DEFAULT,
} from '../constants';

export type { SeatAnchorPos };

export interface RotationSeat {
  id: number;
  pos: SeatAnchorPos;
  name?: string;
  stack?: string | number;
  /**
   * Either a numeric pravatar.cc seed (legacy stand-in avatars) or a full
   * URL string for real Telegram/CDN-hosted avatars. The Avatar component
   * detects URL strings and renders them directly.
   */
  photo?: number | string;
  dealer?: boolean;
  me?: boolean;
  empty?: boolean;
  timer?: number;
  activeBet?: unknown;
  [key: string]: unknown;
}

/**
 * Overrides used to paint REAL player data over the positional placeholders
 * defined in `SEATS_DEFAULT`. Without these, the table would show nameless
 * stand-ins. `mySeat` is the locally authenticated user; `otherSeats` is
 * keyed by seat position (`'top'`, `'left-up'`, …) so the seat-rotation
 * machine can overlay each seat regardless of its current rotated id.
 */
export interface SeatOverlayData {
  name?: string;
  stack?: string | number;
  photo?: string | number;
  empty?: boolean;
}

export interface UseSeatRotationOptions {
  room: { id?: string | number; max?: number; players?: number } | null | undefined;
  spectator: boolean;
  waitForNextRound: boolean;
  onTakeSeat?: (seat: RotationSeat | { pos: SeatAnchorPos } | null) => void;
  /** Real local-user profile painted onto the me-seat (bottom by default). */
  mySeat?: SeatOverlayData | null;
  /** Real other-player snapshots keyed by canonical position. */
  otherSeats?: Partial<Record<SeatAnchorPos, SeatOverlayData>>;
}

export interface UseSeatRotationResult {
  seats: RotationSeat[];
  getDisplayPos: (pos: SeatAnchorPos) => SeatAnchorPos;
  activeDealOrder: SeatAnchorPos[];
  joinedMidDeal: boolean;
  aloneInRoom: boolean;
  dealing: boolean;
  showDealing: boolean;
  handleTakeSeat: (seat: RotationSeat | null) => void;
}

/**
 * Models the "spectator picks a seat → seats slide → user is committed
 * to the chosen position" state machine.
 */
export function useSeatRotation({
  room,
  spectator,
  waitForNextRound,
  onTakeSeat,
  mySeat,
  otherSeats,
}: UseSeatRotationOptions): UseSeatRotationResult {
  const [chosenPos, setChosenPos] = useState<SeatAnchorPos | null>(null);
  const [joinedMidDeal, setJoinedMidDeal] = useState<boolean>(false);
  const [dealing, setDealing] = useState<boolean>(false);
  const seatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (seatTimerRef.current != null) clearTimeout(seatTimerRef.current);
    },
    [],
  );

  // Count real seated players reported by the server. When the caller wires
  // `otherSeats` (real multiplayer mode) we trust this count over the
  // possibly-stale `room.players` field, so the dealing animation never
  // kicks in until at least 2 humans are actually at the table.
  const realPlayerCount = useMemo(() => {
    if (!otherSeats) return null;
    const filledOthers = Object.values(otherSeats).filter(
      (o): o is SeatOverlayData => Boolean(o) && !o.empty,
    ).length;
    return filledOthers + (mySeat ? 1 : 0);
  }, [otherSeats, mySeat]);

  const aloneInRoom = useMemo(() => {
    if (realPlayerCount != null) {
      // In real multiplayer mode the spectator distinction stops mattering:
      // a lone person sitting at the table (regardless of whether they're
      // observing or playing) shouldn't see a phantom deal animation.
      return realPlayerCount <= 1;
    }
    return (room?.players ?? 6) <= 1 && !spectator;
  }, [realPlayerCount, room?.players, spectator]);

  const baseSeats = useMemo<RotationSeat[]>(() => {
    const defaults = SEATS_DEFAULT as RotationSeat[];
    const layoutMap = LAYOUT_SEAT_MAP as Record<number, Array<{ id: number; pos: SeatAnchorPos }>>;
    const maxSeats = Math.min(
      defaults.length,
      Math.max(2, typeof room?.max === 'number' ? room.max : defaults.length),
    );
    if (maxSeats >= defaults.length) return defaults;
    const layout = layoutMap[maxSeats];
    if (!layout) return defaults;
    return layout
      .map(({ id, pos }) => {
        const src = defaults.find((s) => s.id === id);
        return src ? { ...src, pos } : null;
      })
      .filter((s): s is RotationSeat => s !== null);
  }, [room?.max]);

  const rotationOrder = useMemo<SeatAnchorPos[]>(() => {
    const defaults = SEATS_DEFAULT as RotationSeat[];
    const maxSeats = baseSeats.length;
    if (maxSeats >= defaults.length) return DEAL_ORDER as SeatAnchorPos[];
    const order = (LAYOUT_DEAL_ORDER as Record<number, SeatAnchorPos[]>)[maxSeats];
    return order || (DEAL_ORDER as SeatAnchorPos[]);
  }, [baseSeats.length]);

  const rotationOffset = useMemo<number>(() => {
    if (!chosenPos || chosenPos === 'bottom' || joinedMidDeal) return 0;
    const n = rotationOrder.length;
    const bot = rotationOrder.indexOf('bottom');
    const cho = rotationOrder.indexOf(chosenPos);
    if (bot < 0 || cho < 0) return 0;
    return (bot - cho + n) % n;
  }, [chosenPos, joinedMidDeal, rotationOrder]);

  const getDisplayPos = useCallback(
    (pos: SeatAnchorPos): SeatAnchorPos => {
      const i = rotationOrder.indexOf(pos);
      if (i < 0) return pos;
      return rotationOrder[(i + rotationOffset) % rotationOrder.length];
    },
    [rotationOffset, rotationOrder],
  );

  const emptyPositionsBase = useMemo<Set<SeatAnchorPos>>(() => {
    const positions = baseSeats;
    if (aloneInRoom) {
      return new Set(positions.filter((s) => !s.me).map((s) => s.pos));
    }
    // No `Math.max(1, …)` floor: when a room is genuinely empty (0 players)
    // we want every seat to render as empty rather than forcing the first
    // positional placeholder to look occupied.
    const filledCount = Math.min(
      positions.length,
      Math.max(0, typeof room?.players === 'number' ? room.players : positions.length),
    );
    const set = new Set<SeatAnchorPos>();
    let need = positions.length - filledCount;
    for (let i = positions.length - 1; i >= 0 && need > 0; i -= 1) {
      set.add(positions[i].pos);
      need -= 1;
    }
    return set;
  }, [room?.players, baseSeats, aloneInRoom]);

  const seats = useMemo<RotationSeat[]>(() => {
    const myPos: SeatAnchorPos = chosenPos && chosenPos !== 'bottom' ? chosenPos : 'bottom';

    let working: RotationSeat[] = baseSeats.slice();

    if (myPos !== 'bottom') {
      const meIdx = working.findIndex((s) => s.me);
      const newIdx = working.findIndex((s) => s.pos === myPos);
      if (meIdx >= 0 && newIdx >= 0 && meIdx !== newIdx) {
        const meSeat = working[meIdx];
        const newSeat = working[newIdx];
        const { me: _me, timer, name, stack, photo, ...meRest } = meSeat;
        working = working.slice();
        working[meIdx] = { ...meRest, name, stack, photo };
        working[newIdx] = {
          id: newSeat.id,
          pos: newSeat.pos,
          name,
          stack,
          photo,
          me: true,
          ...(timer != null ? { timer } : {}),
        };
      }
    }

    if (spectator && !joinedMidDeal) {
      working = working.map((s) => {
        if (!s.me) return s;
        const { me: _me, timer: _timer, ...rest } = s;
        return rest as RotationSeat;
      });
    } else if (spectator && joinedMidDeal) {
      working = working.map((s) => {
        if (!s.me) return s;
        const { timer: _timer, ...rest } = s;
        return rest as RotationSeat;
      });
    }

    return working.map((s) => {
      if (s.me) {
        // Spectator with no committed seat hides the me-tag; otherwise paint
        // the local-user overlay onto the bottom (or chosen) seat.
        if (!mySeat) return s;
        return {
          ...s,
          ...(mySeat.name != null ? { name: mySeat.name } : {}),
          ...(mySeat.stack != null ? { stack: mySeat.stack } : {}),
          ...(mySeat.photo != null ? { photo: mySeat.photo } : {}),
        };
      }
      if (emptyPositionsBase.has(s.pos) && s.pos !== chosenPos) {
        return { id: s.id, pos: s.pos, empty: true };
      }
      const overlay = otherSeats?.[s.pos];
      if (overlay?.empty) {
        return { id: s.id, pos: s.pos, empty: true };
      }
      if (otherSeats && !overlay) {
        // Caller opted into real-player overlays (passed `otherSeats`), but
        // no snapshot exists for this position — render the seat as empty
        // so the placeholder name/stack from `SEATS_DEFAULT` never leaks
        // onto the felt. When `otherSeats` is `undefined` we fall through
        // to the default-seat data (used by unit tests + mock mode).
        return { id: s.id, pos: s.pos, empty: true };
      }
      if (!overlay) return s;
      return {
        ...s,
        ...(overlay.name != null ? { name: overlay.name } : {}),
        ...(overlay.stack != null ? { stack: overlay.stack } : {}),
        ...(overlay.photo != null ? { photo: overlay.photo } : {}),
      };
    });
  }, [spectator, chosenPos, joinedMidDeal, baseSeats, emptyPositionsBase, mySeat, otherSeats]);

  useEffect(() => {
    if (waitForNextRound || aloneInRoom) {
      setDealing(false);
      return undefined;
    }
    const t = setTimeout(() => setDealing(true), DEAL_START_DELAY_MS);
    return () => clearTimeout(t);
  }, [waitForNextRound, aloneInRoom, room?.id]);

  const handleTakeSeat = useCallback(
    (seat: RotationSeat | null): void => {
      if (!seat || !spectator) {
        onTakeSeat?.(seat);
        return;
      }
      if (dealing) {
        setChosenPos(seat.pos);
        setJoinedMidDeal(true);
        return;
      }
      if (seat.pos === 'bottom') {
        onTakeSeat?.(seat);
        return;
      }
      setChosenPos(seat.pos);
      if (seatTimerRef.current != null) clearTimeout(seatTimerRef.current);
      seatTimerRef.current = setTimeout(() => {
        onTakeSeat?.(seat);
      }, SEAT_ROTATE_MS + 40);
    },
    [onTakeSeat, spectator, dealing],
  );

  useEffect(() => {
    if (!joinedMidDeal || !chosenPos) return undefined;
    const t = setTimeout(() => {
      if (chosenPos === 'bottom') {
        setJoinedMidDeal(false);
        onTakeSeat?.({ pos: 'bottom' });
        return;
      }
      setJoinedMidDeal(false);
      if (seatTimerRef.current != null) clearTimeout(seatTimerRef.current);
      seatTimerRef.current = setTimeout(() => {
        onTakeSeat?.({ pos: chosenPos });
      }, SEAT_ROTATE_MS + 40);
    }, ROUND_END_MS);
    return () => clearTimeout(t);
  }, [joinedMidDeal, chosenPos, onTakeSeat]);

  useEffect(() => {
    setChosenPos(null);
    setJoinedMidDeal(false);
  }, [room?.id]);

  const activeDealOrder = useMemo<SeatAnchorPos[]>(
    () =>
      rotationOrder.filter((pos) =>
        seats.some(
          (seat) =>
            !seat.empty && !(seat.me && joinedMidDeal) && getDisplayPos(seat.pos) === pos,
        ),
      ),
    [seats, getDisplayPos, joinedMidDeal, rotationOrder],
  );

  const showDealing = dealing && !waitForNextRound && (!chosenPos || joinedMidDeal);

  return {
    seats,
    getDisplayPos,
    activeDealOrder,
    joinedMidDeal,
    aloneInRoom,
    dealing,
    showDealing,
    handleTakeSeat,
  };
}
