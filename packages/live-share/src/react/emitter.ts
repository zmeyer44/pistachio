/**
 * A one-way feed of events for the layers that draw them as they come (a
 * ping, a reaction): the room's handler emits, the layer listens and animates
 * a DOM node of its own, and nothing goes through React state.
 */

export interface Emitter<T> {
  emit(value: T): void;
  /** Listen until the returned function is called. */
  on(listener: (value: T) => void): () => void;
}

export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    emit(value) {
      for (const listener of listeners) listener(value);
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
