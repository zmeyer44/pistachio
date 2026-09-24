import type { LinkedState } from "@pistachio/shell-contracts/socket";

/** One device controls linked input. Every handoff fences queued old input. */
export class LinkedSession {
  #state: LinkedState = { enabled: false, generation: 0, controller: null, viewers: [] };
  get state(): LinkedState { return { ...this.#state, viewers: [...this.#state.viewers] }; }
  join(id: string): void {
    if (this.#state.viewers.includes(id)) return;
    this.#state.viewers.push(id);
    if (!this.#state.controller) this.#state.controller = id;
  }
  leave(id: string): void {
    this.#state.viewers = this.#state.viewers.filter(viewer => viewer !== id);
    if (this.#state.controller === id) {
      this.#state.controller = this.#state.viewers[0] ?? null;
      this.#state.generation++;
    }
  }
  change(id: string, action: "enable" | "disable" | "take-control", generation: number): boolean {
    if (!this.#state.viewers.includes(id) || generation !== this.#state.generation) return false;
    if (action === "disable" && this.#state.controller !== id) return false;
    this.#state.enabled = action !== "disable";
    this.#state.controller = id;
    this.#state.generation++;
    return true;
  }
  mayDrive(id: string, generation?: number): boolean {
    if (generation !== undefined && generation !== this.#state.generation) return false;
    return this.#state.viewers.includes(id) && (!this.#state.enabled || (this.#state.controller === id && generation === this.#state.generation));
  }
}
