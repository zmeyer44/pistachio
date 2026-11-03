/** A hand-made time map for the export's tests: pieces of output time, each reading the source from `src` at `rate`. */
import type { TimeMap } from "../src/lib/types.js";

export interface Piece {
  /** Output seconds the piece lasts. */
  length: number;
  /** Source seconds at the piece's start. */
  src: number;
  rate: number;
}

export function piecewiseMap(pieces: Piece[]): TimeMap {
  const starts: number[] = [];
  let duration = 0;
  for (const piece of pieces) {
    starts.push(duration);
    duration += piece.length;
  }
  const pieceAt = (tOut: number): number => {
    let index = 0;
    while (index < pieces.length - 1 && tOut >= (starts[index + 1] as number)) index++;
    return index;
  };
  return {
    duration,
    toSource(tOut) {
      const index = pieceAt(tOut);
      const piece = pieces[index] as Piece;
      return piece.src + (tOut - (starts[index] as number)) * piece.rate;
    },
    toOutput() {
      throw new Error("not used");
    },
    rateAt(tOut) {
      return (pieces[pieceAt(tOut)] as Piece).rate;
    },
  };
}
