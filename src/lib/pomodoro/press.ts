import type { MouseEvent, PointerEvent, TouchEvent } from "react";

/**
 * Tap handling hardened for iOS Safari, including cross-origin preview
 * iframes where `touchend` and `click` arrive inconsistently.
 *
 * Every gesture path (pointerup / touchend / click) may fire the handler;
 * duplicates from one tap are deduped per element. `touchend` is never
 * preventDefaulted — keeping `click` alive as a fallback is the point.
 *
 * Anti-ghost: a tap that unmounts its target (e.g. closing the settings
 * sheet) makes iOS retarget the synthesized click onto whatever moved under
 * the finger. Modern iOS dispatches that ghost within ~100ms of the touch,
 * so a short GLOBAL window plus a per-element window swallow it — while a
 * click carrying `detail === 0` (keyboard / screen-reader / programmatic)
 * always passes through. A newer gesture-start record on the element
 * (lastStartAt > last fire AND > last fire anywhere) proves a retap is
 * real, not an echo — a ghost click carries no start record on the element
 * it lands on, and an abandoned start can't bless a retargeted ghost
 * because the ghost arrives after the fire that spawned it.
 *
 * Constraint: do NOT nest press() controls — the gesture maps key on
 * pointerId/identifier, so a child's record would be overwritten by its
 * bubbling parent and the child's activation would route to the parent.
 */
// All echo windows sit at 300ms: iOS ghost/echo delivery is documented
// ~100ms but jank on a starved iframe main thread can stretch it; a real
// retap inside the window still fires because its fresh start record
// (lastStartAt > lastFire) proves it's not an echo. Only a retap whose
// start events were ALL dropped stays deduped — irreducible ambiguity.
const TOUCH_DEDUP_MS = 300;
const CLICK_GHOST_MS = 300;
const GLOBAL_GHOST_MS = 300;
const TAP_SLOP_PX = 24;
/** How long an unconsumed start record can validate a click as a real
 *  gesture — long enough to cover a held tap (hold + click latency), short
 *  enough that an abandoned start (release dropped off-iframe) can't
 *  shield retargeted ghost clicks for long. */
const CLICK_GESTURE_MS = 600;

const lastTouchFireAt = new WeakMap<EventTarget, number>();
/** DELIVERY time of the last fire per element — kept separate from
 *  lastTouchFireAt because a rescue click back-stamps that map at the
 *  click's generation time, while the record-less release gate's echo
 *  window must be anchored at delivery (an echo arrives after it). */
const lastFireDeliveryAt = new WeakMap<EventTarget, number>();
const ghostClickUntil = new WeakMap<EventTarget, number>();
const lastStartAt = new WeakMap<EventTarget, number>();
/** Last pointer/touch cancel per element — bounds the record-less release
 *  remnant of a scroll-taken-over gesture (dropped touchstart leaves no
 *  slop baseline, so the release must not pass on inside() alone) and the
 *  gesture's own synthesized click (a cancelled gesture isn't a tap). */
const cancelledAt = new WeakMap<EventTarget, number>();
/** Last rejected release per element (slop-fail / slide-off that ended a
 *  gesture without firing) — its retargeted synthesized click must not
 *  activate the element it lands back on. */
const rejectedAt = new WeakMap<EventTarget, number>();
/** A qualifying release that arrived while sibling fingers were still
 *  held — the gesture's final release fires for it even if it lands off
 *  the element. `at` expires the arm; the id sets tie it to the members
 *  held when it was created, so a NEW gesture's release can't consume a
 *  dead gesture's leftover arm (the dead gesture's end events may have
 *  been dropped, leaving phantom starts that mimic "still held"). */
const pendingRelease = new WeakMap<
  EventTarget,
  { at: number; touchIds: Set<number>; pointerIds: Set<number> }
>();
/** Touch identifiers consumed by a completed gesture's fire. A finger held
 *  past STALE_START_MS loses its veto rights, so its eventual release
 *  would look identical to a dropped-start tap — the consumed mark is what
 *  stops it firing a second time. Cleared on any new touchstart carrying
 *  the identifier (iOS recycles ids across gestures). */
const consumedTouches = new Map<number, { at: number; el: EventTarget }>();
let globalGhostUntil = 0;
/** Time of the last activation anywhere — a start record newer than this
 *  belongs to a gesture that began after the last fire, so it can't be
 *  the abandoned remnant a retargeted ghost click would exploit. */
let lastGlobalFireAt = 0;
/** Terminal events on ANY element can spawn a synthesized click that iOS
 *  hit-tests at the release point — landing on a DIFFERENT press element
 *  (e.g. a slide-off rejected on the timer button whose click retargets
 *  onto the adjacent skip). Global reject/cancel markers mirror
 *  lastGlobalFireAt so those clicks are suppressible wherever they land. */
let lastGlobalRejectAt = 0;
let lastGlobalCancelAt = 0;

/** Did a member of THIS gesture take part in the deferred release? The
 *  releasing finger must have been held when the arm was created —
 *  otherwise the arm belongs to a dead gesture whose end events were
 *  dropped, and honoring it would fire a slide-off. */
function armedRelease(
  el: EventTarget,
  now: number,
  ids: readonly number[],
  kind: "touch" | "pointer",
): boolean {
  const arm = pendingRelease.get(el);
  if (!arm || now - arm.at >= STALE_START_MS) {
    pendingRelease.delete(el);
    return false;
  }
  const set = kind === "touch" ? arm.touchIds : arm.pointerIds;
  return ids.some((id) => set.has(id));
}

/** pointerId → start record. Mouse/pen pointerup hits the element under the
 *  release point (no capture), so a drag that merely ENDS over a button must
 *  not fire it — only gestures that started here count. `at` bounds liveness:
 *  an entry older than its stale window can't be part of this tap (and an
 *  undelivered release must not block the control forever — iOS pointerIds
 *  are never recycled in-session). x/y pair the entry to its touch twin. */
const pointerStarts = new Map<
  number,
  { el: EventTarget; at: number; x: number; y: number }
>();

/** touch.identifier → start element + coords + time + paired pointerId,
 *  for release-inside and scroll-slop checks on the touchend path (the one
 *  that survives when iOS delivers touchend but pointercancel already
 *  killed pointerup). */
const touchStarts = new Map<
  number,
  { el: EventTarget; x: number; y: number; at: number; pid?: number }
>();

/** A "finger still down" older than this isn't part of the tap — and a stale
 *  entry from a dropped end-event must not deadlock the element. */
const STALE_START_MS = 1500;
/** Mouse clicks are reliable even on iOS (only touch streams starve), so a
 *  much shorter stale window suffices for the long-hold case — and bounds
 *  the leaked-entry wrong-fire window for in-document drags ending here. */
const MOUSE_STALE_MS = 400;
/** pointerdown precedes touchstart for the same finger; pairing them lets
 *  the pointerup path ignore its own still-present touch twin. The window
 *  is generous — pairing additionally requires same element and ≤8px —
 *  because main-thread jank can separate the twin events arbitrarily. */
const PAIR_WINDOW_MS = 300;
const PAIR_DIST_PX = 8;
/** A record-less touchend arriving within this window of the last fire is
 *  a delayed echo of the already-fired gesture, not a new tap — a tap
 *  whose touchstart was dropped looks identical, but that retap's click
 *  lands outside the ghost window and still rescues it (irreducible
 *  ambiguity; the no-double-fire side is chosen). */
const RELEASE_ECHO_MS = 1000;
/** A click generated within this window of the last fire is that fire's
 *  own synthesized echo — the UA creates it right after the touchend
 *  dispatch completes, so its generation time tracks lastFire even when
 *  delivery is delayed past the ghost windows by main-thread jank. */
const CLICK_SYNTH_MS = 250;
/** A record-less touchend arriving within this window of a pointer/touch
 *  cancel on the same element is the remnant of a scroll-taken-over
 *  gesture — with no start record there is no slop baseline, and panned
 *  content keeps the release point inside the element. */
const CANCEL_ECHO_MS = 500;

const isFresh = (at: number, now: number, window = STALE_START_MS) =>
  now - at < window;

/** Another live pointer still resting on this element? (Skips the just-
 *  released id — callers delete their own entry first anyway.) */
function pointerStillDownOn(el: EventTarget, now: number): boolean {
  for (const s of pointerStarts.values()) {
    if (s.el === el && isFresh(s.at, now)) return true;
  }
  return false;
}

/** A tracked touch still down on this element — covers fingers whose
 *  touchstart arrived but whose pointerdown was dropped. `excludePid` skips
 *  the releasing pointer's own touch twin: pointerup runs before touchend,
 *  so the twin is still in the map and would veto every normal tap. */
function touchStillDownOn(
  el: EventTarget,
  now: number,
  excludePid?: number,
): boolean {
  for (const s of touchStarts.values()) {
    if (s.el !== el || !isFresh(s.at, now)) continue;
    if (excludePid !== undefined && s.pid === excludePid) continue;
    return true;
  }
  return false;
}

/** Still-down touches that STARTED on this element. e.touches lists every
 *  active surface touch (not target-filtered), and Touch.target is the
 *  start element — a finger on a child node (svg icon) counts too. This is
 *  the authoritative "is the gesture alive" source: start records can be
 *  phantoms left by dropped end-events, e.touches cannot. */
function touchHeldOn(el: EventTarget, touches: TouchList): boolean {
  if (!(el instanceof Element)) return touches.length > 0;
  for (const t of Array.from(touches)) {
    const target = t.target;
    if (target === el || (target instanceof Node && el.contains(target))) {
      return true;
    }
  }
  return false;
}

function heldTouchIdsOn(el: EventTarget, touches: TouchList): Set<number> {
  const ids = new Set<number>();
  if (!(el instanceof Element)) {
    for (const t of Array.from(touches)) ids.add(t.identifier);
    return ids;
  }
  for (const t of Array.from(touches)) {
    const target = t.target;
    if (target === el || (target instanceof Node && el.contains(target))) {
      ids.add(t.identifier);
    }
  }
  return ids;
}

/** Firing consumes the whole gesture: every still-tracked same-element
 *  touch is marked consumed (a finger held past STALE_START_MS can't fire
 *  a second activation when it finally lifts) and every same-element start
 *  record is dropped — fresh ones belong to this gesture too, so their
 *  releases are part of the same already-fired interaction. */
function consumeGestureOn(el: EventTarget, now: number) {
  for (const [id, s] of touchStarts) {
    if (s.el === el) {
      consumedTouches.set(id, { at: now, el });
      touchStarts.delete(id);
    }
  }
  for (const [id, s] of pointerStarts) {
    if (s.el === el) pointerStarts.delete(id);
  }
}

/** Snapshot of the gesture's still-held members, stamped onto a deferred
 *  release so only a release BY one of those members can consume it. */
function liveMemberIds(
  el: EventTarget,
  now: number,
  excludePointerId?: number,
  excludeTouchOfPid?: number,
): { touchIds: Set<number>; pointerIds: Set<number> } {
  const touchIds = new Set<number>();
  const pointerIds = new Set<number>();
  for (const [id, s] of touchStarts) {
    if (s.el !== el || !isFresh(s.at, now)) continue;
    if (excludeTouchOfPid !== undefined && s.pid === excludeTouchOfPid) {
      continue;
    }
    touchIds.add(id);
  }
  for (const [id, s] of pointerStarts) {
    if (s.el !== el || !isFresh(s.at, now)) continue;
    if (excludePointerId !== undefined && id === excludePointerId) continue;
    pointerIds.add(id);
  }
  return { touchIds, pointerIds };
}

function isDisabled(el: EventTarget | null): boolean {
  return el instanceof HTMLButtonElement && el.disabled;
}

function inEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest(
        "input, textarea, select, [contenteditable], [role='textbox']",
      ) !== null)
  );
}

function inside(el: EventTarget, x: number, y: number): boolean {
  const r = (el as HTMLElement).getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Stored els are press() currentTargets; a Touch/Event's target is the
 *  innermost hit node — often a CHILD (icon, span) of that element. */
function sameEl(el: EventTarget, target: EventTarget | null): boolean {
  return (
    el === target ||
    (el instanceof Element && target instanceof Node && el.contains(target))
  );
}

/** A genuinely new finger contact is provable by its pointerdown: the same
 *  finger's pointer event always precedes its touchstart (~0ms, same spot).
 *  A still-held finger iOS re-fires (re-listed in changedTouches on its
 *  next move) carries no new pointerdown — that's the discriminator that
 *  separates it from a recycled identifier landing as a fresh contact.
 *  `el` scopes the proof to this element's pointer starts — an unrelated
 *  tap nearby must not clear a held finger's record/mark. In the document
 *  guard the touch's start node stands in for it (sameEl containment). */
function hasFreshPointerNear(
  t: { clientX: number; clientY: number; target?: EventTarget | null },
  now: number,
  el?: EventTarget,
): boolean {
  for (const s of pointerStarts.values()) {
    if (el !== undefined ? s.el !== el : !sameEl(s.el, t.target ?? null)) {
      continue;
    }
    if (
      isFresh(s.at, now, PAIR_WINDOW_MS) &&
      Math.hypot(t.clientX - s.x, t.clientY - s.y) <= PAIR_DIST_PX
    ) {
      return true;
    }
  }
  return false;
}

function fireFromTouch(el: EventTarget, handler: () => void) {
  const now = Date.now();
  const lastFire = lastTouchFireAt.get(el) ?? -1e9;
  // A start newer than the last fire is a genuinely new gesture (fast
  // retap), not a delayed echo — delayed duplicates carry no fresh start.
  if (now - lastFire < TOUCH_DEDUP_MS && (lastStartAt.get(el) ?? 0) <= lastFire) {
    return;
  }
  lastTouchFireAt.set(el, now);
  lastFireDeliveryAt.set(el, now);
  ghostClickUntil.set(el, now + CLICK_GHOST_MS);
  globalGhostUntil = now + GLOBAL_GHOST_MS;
  lastGlobalFireAt = now;
  handler();
}

export function press(handler: () => void) {
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      const now = Date.now();
      // A genuinely new gesture (no live same-element start records): any
      // armed pendingRelease belongs to a gesture whose final release was
      // dropped — it must not fire this gesture's slide-off. Best-effort:
      // fresh phantom records can't be told apart here, but member-stamped
      // arms can only be consumed by their own gesture anyway.
      let live = false;
      for (const s of pointerStarts.values()) {
        if (s.el === e.currentTarget && isFresh(s.at, now)) {
          live = true;
          break;
        }
      }
      if (!live) {
        for (const s of touchStarts.values()) {
          if (s.el === e.currentTarget && isFresh(s.at, now)) {
            live = true;
            break;
          }
        }
      }
      // Defer the verdict to touchstart for touch pointers: its heldHere
      // check reads e.touches — the authoritative held list — which covers
      // members whose own start events were dropped (invisible here).
      // Only a FRESH arm earns the deferral (an expired one has no live
      // members to save, and a recycled id could otherwise collide with a
      // stale member). Mouse/pen have no touchstart — the record check is
      // final for them.
      const arm = pendingRelease.get(e.currentTarget);
      if (
        !live &&
        !(e.pointerType === "touch" && arm && isFresh(arm.at, now))
      ) {
        pendingRelease.delete(e.currentTarget);
      }
      // Record non-primary pointers too — a second finger's pointerup must
      // not find an empty slot, or it would fire after the primary already
      // did (staggered two-finger lift = double activation).
      pointerStarts.set(e.pointerId, {
        el: e.currentTarget,
        at: now,
        x: e.clientX,
        y: e.clientY,
      });
      // A pointer joining while the gesture's arm is live is a member —
      // stamp it now: if every release that could refresh membership is
      // later dropped, the joiner's own release must still consume the arm.
      // `live` gates the stamp: without it a NEW gesture's pointerdown
      // would be written into a dead arm the delete-skip just preserved —
      // and if its touchstart is then dropped, that gesture's slide-off
      // release would consume the dead arm and fire. The !live-but-held
      // case loses nothing: touchstart's heldHere absorption re-adds the
      // paired pid via joinedPids once the arm is proven live.
      if (live && arm && isFresh(arm.at, now)) {
        arm.pointerIds.add(e.pointerId);
      }
      lastStartAt.set(e.currentTarget, now);
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      const rec = pointerStarts.get(e.pointerId);
      pointerStarts.delete(e.pointerId);
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const now = Date.now();
      // Stale start record: for touch/pen the event landing here already
      // proves the gesture started on this element (implicit capture), so
      // a stale entry still counts — a long hold-then-release should fire.
      // For mouse there's no capture: a leaked entry (release outside the
      // iframe never delivers pointerup) plus an in-document drag ending
      // over this element would wrong-fire — so mouse entries count only
      // within a short window; the reliable click covers long clicks.
      const startedHere =
        rec?.el === e.currentTarget &&
        (e.pointerType !== "mouse" || isFresh(rec.at, now, MOUSE_STALE_MS));
      if (!startedHere || !rec) return;
      // Slop applies whenever a record exists — its x/y IS this gesture's
      // start (a phantom record can only belong to a gesture whose own end
      // events were dropped). Mouse keeps native semantics (drag-ending-
      // inside still clicks).
      const qualifies =
        !isDisabled(e.currentTarget) &&
        !inEditable(e.target) &&
        inside(e.currentTarget, e.clientX, e.clientY) &&
        (e.pointerType === "mouse" ||
          Math.hypot(e.clientX - rec.x, e.clientY - rec.y) <= TAP_SLOP_PX);
      // Only the LAST still-down pointer/touch on this element fires —
      // earlier releases while another finger rests on it are part of the
      // same gesture. Both maps are consulted: a finger whose pointerdown
      // or touchstart was dropped lives in only one of them. The releasing
      // pointer's own touch twin is excluded (its touchend hasn't run yet).
      if (
        pointerStillDownOn(e.currentTarget, now) ||
        touchStillDownOn(e.currentTarget, now, e.pointerId)
      ) {
        const prev = pendingRelease.get(e.currentTarget);
        const prevLive = prev !== undefined && isFresh(prev.at, now);
        // Refresh membership even on a non-qualifying release: a finger
        // joining AFTER the arm was created must become a member, or its
        // later release can't consume the deferred fire. `ok`/`qualifies`
        // fabricates the arm; an existing arm only tracks who's held.
        if (qualifies || prevLive) {
          pendingRelease.set(e.currentTarget, {
            // Same stillborn guard as the touch path — an expired arm's
            // timestamp must not be inherited.
            at: prevLive ? prev.at : now,
            ...liveMemberIds(e.currentTarget, now, e.pointerId, e.pointerId),
          });
        } else {
          // Slide-off-only gesture so far (same reasoning as the touch
          // defer path): stamp the rejection so its synthesized click
          // can't fire if the final member's release is dropped.
          rejectedAt.set(e.currentTarget, now);
          lastGlobalRejectAt = now;
        }
        return;
      }
      // A slid-off finger can veto an earlier qualifying release — let the
      // gesture's final release fire for it even off-element, but only if
      // THIS releasing member was held when the arm was created. Guards
      // are re-checked: an armed release must not activate a disabled
      // control.
      const shouldFire =
        (qualifies ||
          armedRelease(e.currentTarget, now, [e.pointerId], "pointer")) &&
        !isDisabled(e.currentTarget) &&
        !inEditable(e.target);
      pendingRelease.delete(e.currentTarget);
      if (!shouldFire) {
        // Gesture ended with no fire — stamp the rejection so a
        // synthesized click retargeted back here is suppressed (a
        // slide-off isn't a tap), and invalidate its start record so a
        // late echo of an OLDER tap can't borrow it as a "new gesture".
        // Only when the record predates this gesture's start: a newer
        // gesture may already have stamped a fresh one.
        rejectedAt.set(e.currentTarget, now);
        lastGlobalRejectAt = now;
        if ((lastStartAt.get(e.currentTarget) ?? 0) <= rec.at + PAIR_WINDOW_MS) {
          lastStartAt.set(e.currentTarget, 0);
        }
        return;
      }
      consumeGestureOn(e.currentTarget, now);
      fireFromTouch(e.currentTarget, handler);
    },
    onPointerCancel: (e: PointerEvent<HTMLElement>) => {
      const now = Date.now();
      const own = pointerStarts.get(e.pointerId);
      pointerStarts.delete(e.pointerId);
      // Did this cancel remove LIVE state (its own fresh record or a
      // paired fresh touch twin)? The stamp it earns below is what stops
      // a record-less remnant touchend — no slop baseline, and panned
      // content keeps the release point inside — from firing a
      // scroll-swipe. Stale records are phantoms of dead gestures: a
      // duplicate cancel finding one earns only the per-el stamp — it
      // must not keep re-arming the GLOBAL marker and suppressing a
      // concurrent gesture's click fallback elsewhere.
      let hadLive =
        own !== undefined &&
        own.el === e.currentTarget &&
        isFresh(own.at, now);
      if (!hadLive) {
        for (const s of touchStarts.values()) {
          if (
            s.el === e.currentTarget &&
            s.pid === e.pointerId &&
            isFresh(s.at, now)
          ) {
            hadLive = true;
            break;
          }
        }
      }
      // Keep the paired touch record: iOS fires pointercancel on scroll
      // takeover yet still delivers touchend — the twin's x/y is the slop
      // baseline that stops a scroll-swipe ending on the element from
      // firing it. touchcancel (or the release path) cleans it up.
      // Clean gesture state only if this cancel ENDED it — a stale cancel
      // arriving mid-gesture must not wipe a newer gesture's arm or start
      // record.
      const gestureDead =
        !pointerStillDownOn(e.currentTarget, now) &&
        !touchStillDownOn(e.currentTarget, now);
      // A cancel that tracked no state can still be the only witness of a
      // gesture whose starts were all dropped: implicit capture means a
      // touch pointer's cancel is dispatched to its start element, so the
      // event landing here proves a gesture ON this element just died —
      // and with nothing live there is no gesture whose click blessing a
      // stamp could revoke. Without it the remnant touchend (panned
      // content keeps the release point inside) fires a scroll-swipe.
      // Per-element only: an untracked gesture never fired, so nothing
      // unmounted to retarget its click onto a different control — a
      // global stamp would only suppress a concurrent gesture's click
      // fallback elsewhere.
      const liveArm = pendingRelease.get(e.currentTarget);
      if (hadLive || (liveArm && isFresh(liveArm.at, now))) {
        cancelledAt.set(e.currentTarget, now);
        lastGlobalCancelAt = now;
      } else if (gestureDead && sameEl(e.currentTarget, e.target)) {
        cancelledAt.set(e.currentTarget, now);
      }
      if (gestureDead) {
        pendingRelease.delete(e.currentTarget);
        lastStartAt.set(e.currentTarget, 0);
      }
    },
    onTouchStart: (e: TouchEvent<HTMLElement>) => {
      const now = Date.now();
      // A genuinely new gesture: check the authoritative list — if no
      // still-held finger (beyond the ones just landing) started on this
      // element, the previous gesture is over, and its armed pendingRelease
      // (final release dropped) must not fire this gesture's slide-off.
      // Phantom start records can't serve here — they outlive the gesture
      // that dropped its end-events, which is exactly the leak being cut.
      const newIds = new Set(
        Array.from(e.nativeEvent.changedTouches).map((t) => t.identifier),
      );
      const armNow = pendingRelease.get(e.currentTarget);
      const armLive = armNow !== undefined && isFresh(armNow.at, now);
      // "Held before this event" = in e.touches on this element, and either
      // not in changedTouches (already down before this event) or carrying
      // positive proof of prior presence on this element: an existing
      // start record, a consumed mark, or membership in a live arm.
      // A genuinely new contact (even if its pointerdown was dropped) carries
      // none of these — so it is correctly recognized as new, allowing an
      // abandoned dead arm to be cleared rather than absorbed.
      const heldHere = Array.from(e.nativeEvent.touches).some((t) => {
        if (!sameEl(e.currentTarget, t.target)) return false;
        if (!newIds.has(t.identifier)) return true;
        const s = touchStarts.get(t.identifier);
        if (s && s.el === e.currentTarget && isFresh(s.at, now)) return true;
        const mark = consumedTouches.get(t.identifier);
        if (mark && sameEl(mark.el, e.currentTarget)) return true;
        if (armLive && armNow.touchIds.has(t.identifier)) return true;
        return false;
      });
      let sawNew = false;
      const claimed = new Set<number>();
      const joinedTids: number[] = [];
      const joinedPids: number[] = [];
      for (const t of Array.from(e.nativeEvent.changedTouches)) {
        // iOS re-lists a still-held finger in changedTouches and re-fires
        // its touchstart on the next move — that finger is part of the
        // ongoing (or already-consumed) gesture, not a new contact. The
        // discriminator: a real new contact's pointerdown just landed at
        // the same spot; a re-fire has none. Without one, a live record or
        // a consumed mark stays untouched (the mark is what stops the held
        // finger's eventual release from re-firing).
        const newContact = hasFreshPointerNear(t, now, e.currentTarget);
        const mark = consumedTouches.get(t.identifier);
        if (mark && !newContact) continue;
        if (mark) consumedTouches.delete(t.identifier);
        const existing = touchStarts.get(t.identifier);
        if (existing && !newContact) {
          // Fresh record + re-fire → keep as-is. A STALE record means the
          // finger is still held past the window — refresh it so its
          // release still counts, but it is NOT a new gesture: don't
          // re-stamp ls or touch the arm.
          if (!isFresh(existing.at, now)) {
            existing.at = now;
            existing.x = t.clientX;
            existing.y = t.clientY;
            delete existing.pid;
          }
          continue;
        }
        sawNew = true;
        joinedTids.push(t.identifier);
        // Pair with the nearest unclaimed same-element pointer start —
        // same finger, same spot, ~0ms apart. The pointerup path uses the
        // pairing to ignore this finger's own still-present touch twin.
        let pid: number | undefined;
        let best = PAIR_DIST_PX;
        for (const [p, s] of pointerStarts) {
          if (s.el !== e.currentTarget || claimed.has(p)) continue;
          if (!isFresh(s.at, now, PAIR_WINDOW_MS)) continue;
          // Skip ids already paired to a live touch record — a second
          // finger whose pointerdown was dropped must not claim the first
          // finger's twin (double-claim would make that finger's release
          // veto its own pointerup AND fire again on touchend).
          let taken = false;
          for (const ts of touchStarts.values()) {
            if (ts.pid === p) {
              taken = true;
              break;
            }
          }
          if (taken) continue;
          const d = Math.hypot(t.clientX - s.x, t.clientY - s.y);
          if (d <= best) {
            best = d;
            pid = p;
          }
        }
        if (pid !== undefined) {
          claimed.add(pid);
          joinedPids.push(pid);
        }
        touchStarts.set(t.identifier, {
          el: e.currentTarget,
          x: t.clientX,
          y: t.clientY,
          at: now,
          pid,
        });
      }
      // Only a genuinely new contact starts a new gesture: a re-fire-only
      // event must neither clear a live deferred release nor re-stamp the
      // start record (a phantom ls would bless the next stray click).
      if (sawNew) {
        if (!heldHere) {
          pendingRelease.delete(e.currentTarget);
        } else {
          // A live arm belongs to this still-running gesture — absorb the
          // joiners so their release can consume it even when every later
          // membership-refreshing release event is dropped.
          const arm = pendingRelease.get(e.currentTarget);
          if (arm && now - arm.at < STALE_START_MS) {
            for (const id of joinedTids) arm.touchIds.add(id);
            for (const p of joinedPids) arm.pointerIds.add(p);
          }
        }
        lastStartAt.set(e.currentTarget, now);
      }
    },
    onTouchEnd: (e: TouchEvent<HTMLElement>) => {
      const el = e.currentTarget;
      const now = Date.now();
      // Touches still in contact anywhere — used only to avoid deleting a
      // still-held finger iOS lists in changedTouches (it re-fires its
      // touchstart on the next move).
      const stillDown = new Set(
        Array.from(e.nativeEvent.touches).map((t) => t.identifier),
      );
      let ok = false;
      let maxStart = -1;
      const releasedIds: number[] = [];
      // Members of the live arm are exempt from the consumed-mark and
      // record-less gates below: their presence in arm.touchIds was proven
      // by e.touches (the authoritative held list) when the arm was made,
      // so their release MUST reach releasedIds for armedRelease — or the
      // deferred fire is lost to an echo/cancel window it isn't part of.
      const armNow = pendingRelease.get(el);
      const armTids =
        armNow && now - armNow.at < STALE_START_MS ? armNow.touchIds : null;
      for (const t of Array.from(e.nativeEvent.changedTouches)) {
        // Still physically down (iOS lists held fingers in changedTouches)
        // — not a release at all; keep its record AND any consumed mark.
        if (stillDown.has(t.identifier)) continue;
        const s = touchStarts.get(t.identifier);
        const isArmMember = armTids?.has(t.identifier) === true;
        // A release from a gesture that already fired — its record was
        // consumed; without the mark it would pass as a dropped-start tap
        // and fire a second time once the dedup window elapsed. The mark
        // is kept (not consumed) so a SECOND duplicate release beyond the
        // echo window can't re-fire either; it clears only on a proven
        // new contact in the touchstart paths.
        if (consumedTouches.has(t.identifier)) {
          if (s) touchStarts.delete(t.identifier);
          if (!isArmMember) continue;
        }
        if (s && s.el !== el) continue;
        // A record-less release is only trustworthy away from three recent
        // terminal events: a fire on this element (delayed echo of that
        // gesture), a pointer/touch cancel (scroll-takeover remnant), and
        // a rejection (the judged non-tap's own echo release — it carries
        // no slop baseline, and panned/off-element content can keep the
        // release point inside). Arm members are exempt — membership
        // proves this release belongs to the armed gesture.
        if (
          !s &&
          !isArmMember &&
          (now - (lastFireDeliveryAt.get(el) ?? -1e9) < RELEASE_ECHO_MS ||
            now - (cancelledAt.get(el) ?? -1e9) < CANCEL_ECHO_MS ||
            now - (rejectedAt.get(el) ?? -1e9) < CANCEL_ECHO_MS)
        ) {
          continue;
        }
        if (s) {
          touchStarts.delete(t.identifier);
          // The paired pointer is gone too (its pointerup ran or was
          // dropped) — remove it so the phantom can't veto this fire.
          if (s.pid !== undefined) pointerStarts.delete(s.pid);
          if (s.at > maxStart) maxStart = s.at;
        }
        releasedIds.push(t.identifier);
        // touchend dispatched to el proves the touch STARTED on el even
        // when we never saw its touchstart (s undefined). Slop applies to
        // every record regardless of age — a phantom record's x/y still
        // belongs to THIS gesture's start.
        if (
          inside(el, t.clientX, t.clientY) &&
          (!s || Math.hypot(t.clientX - s.x, t.clientY - s.y) <= TAP_SLOP_PX)
        ) {
          ok = true;
        }
      }
      // A finger that started here is still down — the gesture isn't over;
      // the final release fires alone. Remember a qualifying release so a
      // slid-off last finger can't take the whole gesture down with it.
      const heldIds = touchHeldOn(el, e.nativeEvent.touches)
        ? heldTouchIdsOn(el, e.nativeEvent.touches)
        : null;
      if (heldIds) {
        const prev = pendingRelease.get(el);
        const prevLive = prev !== undefined && isFresh(prev.at, now);
        if (ok || prevLive) {
          const pointerIds = new Set<number>();
          for (const [id, s] of pointerStarts) {
            if (s.el === el && isFresh(s.at, now)) pointerIds.add(id);
          }
          pendingRelease.set(el, {
            // An expired arm's timestamp must not be inherited — the
            // refreshed arm would be stillborn (armedRelease rejects it
            // instantly) and every later refresh would re-poison it.
            at: prevLive ? prev.at : now,
            touchIds: heldIds,
            pointerIds,
          });
        } else if (releasedIds.length > 0) {
          // A member slid off with no qualifying release anywhere so far
          // — the gesture is slide-off-only. Mark the rejection so a
          // click synthesized for it can't fire wherever the final
          // member's (possibly dropped) release lands. A later member's
          // qualifying release still fires via the release path — this
          // only denies the click fallback.
          rejectedAt.set(el, now);
          lastGlobalRejectAt = now;
        }
        // The deferred members released for real — mark them consumed so
        // a >RELEASE_ECHO_MS-late duplicate of THIS release can't pass
        // the record-less gate as a dropped-start tap and fire again.
        for (const id of releasedIds) {
          consumedTouches.set(id, { at: now, el });
        }
        return;
      }
      // No finger that started here is still down — leftover same-element
      // pointerStarts are phantoms (their pointerup was dropped) or a held
      // mouse; either way this release owns the gesture.
      for (const [pid, s] of pointerStarts) {
        if (s.el === el) pointerStarts.delete(pid);
      }
      // No touches on the surface at all → every touchStarts entry is a
      // phantom from a dropped end-event.
      if (e.nativeEvent.touches.length === 0) touchStarts.clear();
      // An armed release is geometry evidence, not permission — disabled /
      // editable guards apply at consume time too, and only a member held
      // when the arm was created can consume it.
      const shouldFire =
        (ok || armedRelease(el, now, releasedIds, "touch")) &&
        !isDisabled(el) &&
        !inEditable(e.target);
      // Only a real observed release ends the gesture — a stray event
      // whose changedTouches were all filtered (consumed non-members,
      // gated echoes) must not drop a live arm before its members' own
      // release events arrive to consume it.
      if (releasedIds.length > 0) pendingRelease.delete(el);
      if (!shouldFire) {
        // A real release ended the gesture with no fire — stamp the
        // rejection so a synthesized click retargeted back here is
        // suppressed (a slide-off isn't a tap), and invalidate its start
        // record so a late echo of an OLDER tap can't borrow it as a
        // "new gesture". ls is the gesture's LAST member start, so it
        // must predate the newest member we saw; a later gesture's stamp
        // must survive.
        if (releasedIds.length > 0) {
          rejectedAt.set(el, now);
          lastGlobalRejectAt = now;
        }
        if (maxStart >= 0 && (lastStartAt.get(el) ?? 0) <= maxStart) {
          lastStartAt.set(el, 0);
        }
        return;
      }
      consumeGestureOn(el, now);
      // The releasing touches are consumed too — a >300ms-late duplicate
      // touchend for one of them would otherwise pass as a dropped-start
      // tap and fire again.
      for (const id of releasedIds) consumedTouches.set(id, { at: now, el });
      fireFromTouch(el, handler);
    },
    onTouchCancel: (e: TouchEvent<HTMLElement>) => {
      const now = Date.now();
      const stillDown = new Set(
        Array.from(e.nativeEvent.touches).map((t) => t.identifier),
      );
      let touched = false;
      for (const t of Array.from(e.nativeEvent.changedTouches)) {
        if (stillDown.has(t.identifier)) continue;
        // Keep consumed marks — iOS can still deliver this finger's
        // touchend after a cancel, and without the mark a late echo
        // passes the record-less path once RELEASE_ECHO_MS elapses.
        const s = touchStarts.get(t.identifier);
        if (s && s.el !== e.currentTarget) continue;
        // Only a FRESH record counts as live state removed — a stale one
        // is a dead gesture's phantom, and re-stamping the global marker
        // for it would keep suppressing other elements' click fallbacks.
        if (s && isFresh(s.at, now)) touched = true;
        if (s?.pid !== undefined) pointerStarts.delete(s.pid);
        touchStarts.delete(t.identifier);
      }
      // Clean gesture state only if this cancel ENDED it — a stale cancel
      // arriving mid-gesture must not wipe a live arm or start record.
      const gestureDead =
        !touchHeldOn(e.currentTarget, e.nativeEvent.touches) &&
        !pointerStillDownOn(e.currentTarget, now) &&
        !touchStillDownOn(e.currentTarget, now);
      // Same remnant guard as pointercancel: stamp when live state (or a
      // live arm) was actually involved — a stale/duplicate cancel
      // arriving mid-gesture must not un-bless a newer gesture's click
      // fallback. Additionally stamp when a cancelled touch's own start
      // target is this element and nothing is live: the gesture's starts
      // were all dropped, so this cancel is the only witness — the stamp
      // is what suppresses its remnant touchend, and a dead gesture has
      // no click blessing to revoke.
      // An EXPIRED arm is not live state — it earns no global stamp.
      const armNow = pendingRelease.get(e.currentTarget);
      if (touched || (armNow && isFresh(armNow.at, now))) {
        cancelledAt.set(e.currentTarget, now);
        lastGlobalCancelAt = now;
      } else if (
        gestureDead &&
        Array.from(e.nativeEvent.changedTouches).some((t) =>
          sameEl(e.currentTarget, t.target),
        )
      ) {
        // Stateless cancel — per-element stamp only (see pointercancel).
        cancelledAt.set(e.currentTarget, now);
      }
      if (gestureDead) {
        pendingRelease.delete(e.currentTarget);
        lastStartAt.set(e.currentTarget, 0);
      }
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (isDisabled(e.currentTarget) || inEditable(e.target)) return;
      const now = Date.now();
      // detail === 0 → keyboard / screen-reader / programmatic activation:
      // no pointer/touch stream exists, so always let it through. Record
      // the fire anyway so a near-coincident physical release dedups
      // against it instead of double-activating.
      if (e.detail === 0) {
        lastTouchFireAt.set(e.currentTarget, now);
        lastFireDeliveryAt.set(e.currentTarget, now);
        handler();
        return;
      }
      const lastFire = lastTouchFireAt.get(e.currentTarget) ?? -1e9;
      const ls = lastStartAt.get(e.currentTarget) ?? 0;
      const cancelled = cancelledAt.get(e.currentTarget) ?? -1e9;
      const rejected = rejectedAt.get(e.currentTarget) ?? -1e9;
      // The click's GENERATION time (event.timeStamp rebased onto
      // Date.now) tells it apart from a delayed echo: the UA creates the
      // synthesized click right after the touchend dispatch completes, so
      // an echo's clickAt sits ~AT the last fire — it can never postdate
      // the current gesture's start. A click carrying newGesture must
      // have been generated after that start to belong to it.
      const clickAt = Math.min(
        performance.timeOrigin + e.nativeEvent.timeStamp,
        now + 60_000, // engines with epoch-based timeStamp fail open, bounded
      );
      // A start record proves a real gesture is in flight — but only
      // while fresh (CLICK_GESTURE_MS), only if it began past the last
      // terminal event's synthesis window ANYWHERE (a start landing inside
      // the window can't tell its own click from that fire's echo — an
      // abandoned or near-coincident record must not bless a retargeted
      // ghost), only if it postdates any cancel/rejection (a cancelled
      // gesture isn't a tap), and only if this click itself postdates that
      // gesture's start (not an old echo borrowing the start record).
      const newGesture =
        ls > lastFire + CLICK_SYNTH_MS &&
        ls > lastGlobalFireAt + CLICK_SYNTH_MS &&
        ls > lastGlobalCancelAt + CLICK_SYNTH_MS &&
        ls > lastGlobalRejectAt + CLICK_SYNTH_MS &&
        ls > cancelled &&
        ls > rejected &&
        now - ls < CLICK_GESTURE_MS &&
        clickAt > ls - 10;
      if (
        !newGesture &&
        // A click generated at/around a terminal event is that event's
        // own echo — suppress regardless of delivery delay (jank can push
        // it past the ghost windows). The RETARGETED variant tracks the
        // spawning element's terminal event — rejections and cancels
        // included — so the global markers are checked too. A genuinely
        // older straggler whose gesture never fired lands here as well;
        // suppressing it is safer than activating a control whose meaning
        // has since changed.
        (clickAt <= lastFire + CLICK_SYNTH_MS ||
          clickAt <= lastGlobalFireAt + CLICK_SYNTH_MS ||
          clickAt <= cancelled + CLICK_SYNTH_MS ||
          clickAt <= rejected + CLICK_SYNTH_MS ||
          clickAt <= lastGlobalCancelAt + CLICK_SYNTH_MS ||
          clickAt <= lastGlobalRejectAt + CLICK_SYNTH_MS ||
          now < (ghostClickUntil.get(e.currentTarget) ?? 0) ||
          now < globalGhostUntil)
      ) {
        // Ghosted: kill the click so it can't also trigger default action
        // (a submit-type button would otherwise submit the form).
        e.preventDefault();
        return;
      }
      // A click provably generated BEFORE the in-flight gesture started
      // (clickAt predates ls) is an OLDER tap's rescue, not this
      // gesture's own. Stamp lastFire at its generation time — not the
      // delayed delivery time, which would let the dedup window swallow
      // the newer gesture's release — and consume only records created
      // before the click was generated: the newer gesture's records and
      // arm must survive so its own release can still complete it.
      const rescueOfOlder = ls > lastFire && clickAt <= ls - 10;
      lastTouchFireAt.set(e.currentTarget, rescueOfOlder ? clickAt : now);
      lastFireDeliveryAt.set(e.currentTarget, now);
      ghostClickUntil.set(e.currentTarget, now + CLICK_GHOST_MS);
      globalGhostUntil = now + GLOBAL_GHOST_MS;
      lastGlobalFireAt = rescueOfOlder ? clickAt : now;
      if (rescueOfOlder) {
        for (const [id, s] of touchStarts) {
          if (s.el === e.currentTarget && s.at <= clickAt) {
            consumedTouches.set(id, { at: now, el: e.currentTarget });
            touchStarts.delete(id);
          }
        }
        for (const [id, s] of pointerStarts) {
          if (s.el === e.currentTarget && s.at <= clickAt) {
            pointerStarts.delete(id);
          }
        }
      } else {
        // The gesture completed via click — its members and any deferred
        // release are consumed so they can't fire a later slide-off.
        pendingRelease.delete(e.currentTarget);
        consumeGestureOn(e.currentTarget, now);
      }
      // Not ghosted: run the handler AND let the default proceed — a click
      // on a submit button still submits the form, whose commit path is
      // dedup-guarded, giving a second independent fallback.
      handler();
    },
  };
}

let guardsInstalled = false;
/**
 * Document-level hygiene for the gesture-start maps, in bubble phase so it
 * runs AFTER the React handlers: a pointerup/touchend/cancel landing on a
 * non-press element would otherwise leave a stale "started here" entry —
 * and a recycled pointerId (mouse is always 1) could later arm a button the
 * gesture never began on. Install once from a client effect.
 */
export function installPressGuards() {
  if (guardsInstalled || typeof document === "undefined") return;
  guardsInstalled = true;
  // Capture phase so these run BEFORE the delegated element handlers: a new
  // gesture start invalidates any stale entry left by a pointer released
  // outside the document (mouse out-of-iframe release never delivers
  // pointerup/cancel here, and mouse pointerId is always 1).
  document.addEventListener(
    "pointerdown",
    (e) => {
      pointerStarts.delete(e.pointerId);
    },
    true,
  );
  document.addEventListener(
    "touchstart",
    (e) => {
      // iOS re-fires touchstart for a still-held finger on its next move —
      // that dispatch targets the finger's START node, a descendant of the
      // recorded press element. Distinguish it from a recycled identifier
      // by proof of a real new contact: its pointerdown just landed at the
      // same spot (hasFreshPointerNear). Without one, a record or consumed
      // mark belonging to this element stays — clearing a held finger's
      // mark would let its release re-fire.
      for (const t of Array.from(e.changedTouches)) {
        const s = touchStarts.get(t.identifier);
        const mark = consumedTouches.get(t.identifier);
        // A still-held finger iOS re-fires has no fresh pointerdown; keep
        // its record/mark when they belong to its start element — t.target
        // (this touch's own start node, a descendant of the recorded el),
        // not e.target, which a coalesced multi-element touchstart can
        // misreport for non-primary touches.
        if (!hasFreshPointerNear(t, Date.now())) {
          if (s && sameEl(s.el, t.target)) continue;
          if (mark && sameEl(mark.el, t.target)) continue;
        }
        if (s?.pid !== undefined) pointerStarts.delete(s.pid);
        touchStarts.delete(t.identifier);
        consumedTouches.delete(t.identifier);
      }
    },
    true,
  );
  // Bubble phase — runs after the element handlers that may legitimately
  // consume their own entry, then mops up releases on non-press elements.
  document.addEventListener("pointerup", (e) => {
    pointerStarts.delete(e.pointerId);
  });
  document.addEventListener("pointercancel", (e) => {
    pointerStarts.delete(e.pointerId);
  });
  const dropTouches = (e: globalThis.TouchEvent) => {
    const stillDown = new Set(Array.from(e.touches).map((t) => t.identifier));
    for (const t of Array.from(e.changedTouches)) {
      if (stillDown.has(t.identifier)) continue;
      const s = touchStarts.get(t.identifier);
      if (s?.pid !== undefined) pointerStarts.delete(s.pid);
      touchStarts.delete(t.identifier);
    }
  };
  document.addEventListener("touchend", dropTouches);
  document.addEventListener("touchcancel", dropTouches);
}
