import { createContext, useContext } from 'react';
import { HISTORY_LIMIT } from './history.js';

export const AppContext = createContext(null);
export function useBus() { return useContext(AppContext).bus; }

const ref = current => ({ current });

// Access to App-owned state, not another document store. The optional refs let
// an owner supply its existing cells; the facade never owns React setters.
export function createAppContext({
  clock: opClockRef = ref(0), history: charHistoryRef = ref({ past: [], future: [] }),
  objectClock: lastObjectOpRef = ref(0), suppressObjectClock: suppressObjectClockRef = ref(false),
  characters: charactersRef = ref(null), scenes: scenesRef = ref(null),
  motion: motionRef = ref(null), state: liveStateRef = ref(null), getBus,
} = {}) {
  const ports = {}, actionPorts = {};
  let currentPorts = {};
  const nextTick = () => ++opClockRef.current;
  function record(snapshot) {
    charHistoryRef.current.past.push({ tick: nextTick(), snapshot });
    charHistoryRef.current.past = charHistoryRef.current.past.slice(-HISTORY_LIMIT);
    charHistoryRef.current.future = [];
  }
  return {
    get undoClock() { return opClockRef.current; },
    nextTick,
    get objectClock() { return lastObjectOpRef.current; },
    get suppressObjectClock() { return suppressObjectClockRef.current; },
    set suppressObjectClock(value) { suppressObjectClockRef.current = value; },
    objectChanged() {
      if (!suppressObjectClockRef.current) lastObjectOpRef.current = nextTick();
    },
    advanceObjectClock() { lastObjectOpRef.current = nextTick(); },
    get castHistory() { return charHistoryRef.current; },
    resetCastHistory() { charHistoryRef.current = { past: [], future: [] }; },
    recordCharacterUndo: record,
    recordShotUndo: record,
    // Getter-only projections retain identity (including renderer buffers).
    // Publications are explicit; no copies or second source of truth.
    live: Object.freeze({
      get state() { return liveStateRef.current; },
      get characters() { return charactersRef.current; },
      get scenes() { return scenesRef.current; },
      get motion() { return motionRef.current; },
    }),
    publishLive(value) { liveStateRef.current = value; },
    patchLive(patch) { Object.assign(liveStateRef.current, patch); },
    patchTimeline(patch) { Object.assign(liveStateRef.current.timeline, patch); },
    publishCharacters(value) { charactersRef.current = value; },
    publishScenes(value) { scenesRef.current = value; },
    publishMotion(value) { motionRef.current = value; },
    get bus() { return getBus(); },
    ports,
    actionPorts,
    updatePorts(next) {
      currentPorts = next;
      for (const key of Object.keys(next)) {
        if (key === 'revision') ports[key] = next[key];
        else if (!ports[key]) ports[key] = (...args) => currentPorts[key](...args);
      }
    },
    updateActionPorts(next) { Object.assign(actionPorts, next); },
  };
}
